const async = require('async');
const AWS = require('aws-sdk');
const http = require('http');
const jsonStream = require('JSONStream');
const stream = require('stream');
const Logger = require('werelogs').Logger;
const { constants, errors } = require('arsenal');

const util = require('util');

const BackbeatClient = require('../clients/BackbeatClient');
const { attachReqUids } = require('../clients/utils');
const RaftLogEntry = require('../models/RaftLogEntry');

class ListRecordStream extends stream.Transform {
    constructor(logger) {
        super({ objectMode: true });
        this.logger = logger;
    }

    _transform(itemObj, encoding, callback) {
        itemObj.entries.forEach(entry => {
            // eslint-disable-next-line no-param-reassign
            entry.type = entry.type || 'put';
        });
        this.push(itemObj);
        callback();
    }
}

class IngestionProducer {
    /**
     * Create an IngestionProducer class that helps create a snapshot of
     * pre-existing RING backend
     *
     * @constructor
     * @param {object} sourceConfig - source config (also called bucketdConfig)
     * @param {object} qpConfig - queuePopulator config object with value for
     *                            sslEnabled
     * @param {object} s3Config - S3 config object with value for host and port
     *                            of BackbeatClient endpoint
     */
    constructor(sourceConfig, qpConfig, s3Config) {
        this.log = new Logger('Backbeat:IngestionProducer');
        this.qpConfig = qpConfig;
        this.s3sourceCredentials = new AWS.Credentials({
            accessKeyId: sourceConfig.auth.accessKey,
            secretAccessKey: sourceConfig.auth.secretKey,
        });

        const { https, host, port } = sourceConfig;
        const protocol = https ? 'https' : 'http';
        console.log(`ENDPOINT: ${protocol}://${host}:${port}`)

        this.s3source = s3Config;
        this._targetZenkoBucket = sourceConfig.name;
        this.requestLogger = this.log.newRequestLogger();
        this.createEntry = new RaftLogEntry();
        this.resLog = [];
        this.sourceHTTPAgent = new http.Agent({ keepAlive: true });

        this.ringReader = new BackbeatClient({
            endpoint: `${protocol}://${host}:${port}`,
            credentials: this.s3sourceCredentials,
            sslEnabled: sourceConfig.auth.https,
            httpOptions: { agent: this.sourceHTTPAgent, timeout: 0 },
            maxRetries: 0,
        });
    }

    /**
     * Find the raft session that the bucket exists on
     * @param {string} bucketName - name of sourcebucket that needs logs
     * @param {function} done - callback function
     * @return {number} the raftId that has logs for the bucket
     */
    getRaftId(bucketName, done) {
        console.log(`BUCKET: ${bucketName}`)
        const req = this.ringReader.getRaftId({
            Bucket: bucketName,
        });

        attachReqUids(req, this.requestLogger);
        req.send((err, data) => {
            if (err) {
                this.log.error(`could not find bucket ${bucketName} in any` +
                ' raft session', { method: 'getRaftId', bucketName, err });
                return done(err);
            } else if (data && data[0]) {
                return done(null, data[0]);
            }
            this.log.info(`empty response for raftid of ${bucketName}`,
            { method: 'getRaftId', bucketName });
            return done(errors.InternalError);
        });
    }

    /**
     * generate a listing of all current objects that exists on the source
     * bucket, including the bucket MD to create the correct entries
     * @param {string} bucketName - name of source bucket
     * @param {function} done - callback function
     * @return {object} resLog value
     *
     */
    snapshot(bucketName, done) {
        async.waterfall([
            next => this._getBucketObjects([bucketName], next),
            (bucketList, next) =>
                this._getBucketObjectsMetadata(bucketList, next),
        ], err => done(err, this.resLog));
    }

    getRaftLog(raftId, begin, end, targetLeader, done) {
        const recordStream = new ListRecordStream(this.log);
        recordStream.on('error', err => {
            if (err.statusCode === 404) {
                console.log('404 ERROR')
                // no such raft session, log and ignore
                this.log.warn('raft session does not exist',
                    { raftId: this.raftId, method:
                    'IngestionProducer.getRaftLog' });
                return done(null, { info: { start: null,
                    end: null } });
            }
            if (err.statusCode === 416) {
                console.log('416 ERROR')
                // requested range not satisfiable
                this.log.debug('no new log records to ' +
                    'process', {
                        raftId: this.raftId,
                        method: 'IngestionProducer.getRaftLog',
                    });
                return done(null, { info: { start: null,
                    end: null } });
            }
            this.log.error('error receiving raft log',
            { error: err });
            return done(errors.InternalError);
        });
        const req = this.ringReader.getRaftLog({
            LogId: raftId.toString(),
            Begin: begin,
            End: end,
            TargetLeader: targetLeader,
        });
        attachReqUids(req, this.requestLogger);

        const readStream = req.createReadStream();
        readStream.on('error', err => {
            console.log('readStream got an error and sending to recordStream')
            console.log(JSON.stringify(err))
            recordStream.emit('error', err)
        });
        const jsonResponse = readStream.pipe(jsonStream.parse('log.*'));

        jsonResponse
            .on('header', header => {
                recordStream.removeAllListeners('error');
                console.log('jsonResponse on header success')
                // console.log(JSON.stringify(header))
                return done(null, {
                    info: header.info,
                    log: jsonResponse,
                });
            })
            .on('error', err => {
                console.log('jsonResponse got an error and sending to recordStream')
                console.log(JSON.stringify(err))
                recordStream.emit('error', err)
            })
            .on('end', () => {
                console.log('GOT END IN jsonResponse')
            })
        jsonResponse.pipe(recordStream);
        return undefined;
    }

    _parseBucketName(bucketKey) {
        return bucketKey.split(constants.splitter)[1];
    }

    /**
     * get the list of objects for each bucket
     *
     * @param {object} bucketList - list of buckets
     * @param {function} done - callback function
     * @return {object} list of buckets and list of objects for each bucket
     */
    _getBucketObjects(bucketList, done) {
        if (!bucketList) {
            console.log('UNEXPECTED...')
            return done(null, null);
        }
        return async.mapLimit(bucketList, 10, (bucketInfo, cb) => {
            if (bucketInfo === constants.usersBucket ||
            bucketInfo === constants.metastoreBucket) {
                return cb();
            }
            const req = this.ringReader.getObjectList({
                Bucket: bucketInfo,
            });
            attachReqUids(req, this.requestLogger);
            return req.send((err, data) => {
                if (err) {
                    this.log.error('error getting list of objects', {
                        method: 'IngestionProducer:getBucketObjects', err });
                    return cb(err);
                }
                return cb(null, { bucket: bucketInfo, objects: data.Contents });
            });
        }, (err, buckets) => done(err, buckets));
    }

    /**
     * get metadata for all objects, and send the info to kafka
     *
     * @param {object} bucketObjectList - list of buckets and list of objects
     * for each bucket
     * @param {function} done - callback function
     * @return {undefined}
     */
    _getBucketObjectsMetadata(bucketObjectList, done) {
        if (!bucketObjectList) {
            return done(null, null);
        }
        return async.mapSeries(bucketObjectList, (bucket, cb) => {
            if (!bucket) {
                return cb();
            }
            const bucketName = bucket.bucket;
            console.log(`bucketName?: ${bucketName}`)
            return async.mapLimit(bucket.objects, 10, (object, cb) => {
                const objectKey = object.key;
                const req = this.ringReader.getObjectMetadata({
                    Bucket: bucketName,
                    Key: objectKey,
                });
                attachReqUids(req, this.requestLogger);
                return req.send((err, data) => {
                    if (err) {
                        this.log.error('error getting metadata for object', {
                            method: 'IngestionoProducer:getBucketObjects' +
                            'Metadata', err });
                    }
                    // console.log(util.inspect(data, { depth: 4 }))
                    return cb(null, { res: data, objectKey, bucketName });
                });
            }, (err, objectMDs) => {
                if (err) {
                    return cb(err);
                }
                console.log(`-> snapshot created ${objectMDs.length} entries`)
                return this._createAndPushEntry(objectMDs, cb);
            });
        }, err => done(err));
    }

    _createAndPushEntry(objectMds, done) {
        console.log('IN _createAndPushEntry')
        if (objectMds.length > 0) {
            return async.eachLimit(objectMds, 10, (objectMd, cb) => {
                const objectMdEntry =
                    this.createEntry.createPutEntry(objectMd,
                        this._targetZenkoBucket);
                this.resLog.push(objectMdEntry);
                return cb();
            }, err => {
                if (err) {
                    this.log.error('error sending objectMd to kafka', {
                        err,
                    });
                }
                return done(err);
            });
        }
        return done();
    }
}

module.exports = IngestionProducer;
