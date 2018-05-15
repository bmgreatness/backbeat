const { usersBucket } = require('arsenal').constants;

class RaftLogEntry {

    /**
     * method to format an entry for object metadata
     *
     * @param {object} objectMd - object info to format entry
     * @param {string} bucketPrefix - prefix for bucketname to avoid name clash
     * @return {object} JSON.stringified entry value to be sent to kafka
     */
    createPutEntry(objectMd, bucketPrefix) {
        // TODO: substitue canonical id;
        // objectMd.res['owner-id'] = '';
        return {
            type: 'put',
            bucket: `${bucketPrefix}-${objectMd.bucketName}`,
            // bucket: objectMd.bucketName,
            key: objectMd.objectKey,
            value: JSON.stringify(objectMd.res),
        };
    }

    /**
     * method to format an entry for a bucket - formatted as an object that is
     * a part of the usersBucket
     *
     * @param {object} bucket - bucket info to format entry
     * @param {object} res - bucket info
     * @param {string} bucketPrefix - prefix for bucketname to avoid name clash
     * @return {object} formatted entry for bucket as an object
     */
    createPutBucketEntry(bucket, res, bucketPrefix) {
        // TODO: substitute canonical id;
        // res._owner = '';
        return {
            type: 'put',
            bucket: usersBucket,
            key: `${res._owner}..|..${bucketPrefix}-${bucket}`,
            // key: `${res._owner}..|..${bucket}`,
            value: res._creationDate,
        };
    }

    /**
     * method to format an entry for bucket metadadta
     *
     * @param {object} bucket - bucket info to format entry
     * @param {string} bucketPrefix - prefix for bucketname to avoid name clash
     * @return {object} formatted entry for bucket metadata
     */
    createPutBucketMdEntry(bucket, bucketPrefix) {
        // TODO: substitute canonical id;
        // bucket._owner = '';
        return {
            type: 'put',
            bucket: `${bucketPrefix}-${bucket._name}`,
            // bucket: bucket._name,
            key: `${bucketPrefix}-${bucket._name}`,
            // key: bucket._name,
            value: bucket.serialize(),
        };
    }
}

module.exports = RaftLogEntry;
