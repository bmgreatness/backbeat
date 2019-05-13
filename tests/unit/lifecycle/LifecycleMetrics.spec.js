const assert = require('assert');

const errors = require('arsenal').errors;
const werelogs = require('werelogs');

const LifecycleMetrics =
      require('../../../extensions/lifecycle/LifecycleMetrics');
const queueMetricNames =
      require('../../../lib/constants').kafkaBacklogMetrics.promMetricNames;
const replicationMetricNames =
      require('../../../extensions/replication/constants').promMetricNames;
const log = new werelogs.Logger('test:LifecycleMetrics');

const config = require('../../../conf/Config');
const repConfig = config.extensions.replication;
const lifecycleConfig = config.extensions.lifecycle;

const MOCK_QUERY_NONEMPTY_RESPONSES_PHASE_1 = [{
    queryRegexp: new RegExp(
        `^max\\(max\\(${queueMetricNames.latestPublishedMessageTimestamp}{`),
    response: [
        {
            metric: {
                consumergroup: lifecycleConfig.bucketProcessor.groupId,
                topic: lifecycleConfig.bucketTasksTopic,
            },
            value: [
                1557513677.374,
                '420.86800003051758',
            ],
        },
        {
            metric: {
                consumergroup: lifecycleConfig.objectProcessor.groupId,
                topic: lifecycleConfig.objectTasksTopic,
            },
            value: [
                1557513677.374,
                '386.73800015449524',
            ],
        },
        {
            metric: {
                consumergroup: `${repConfig.queueProcessor.groupId}-aws`,
                topic: repConfig.dataMoverTopic,
            },
            value: [
                1557513677.374,
                '1305.61400008201599',
            ],
        }
    ],
}, {
    queryRegexp: new RegExp(
        `^max\\(${queueMetricNames.latestConsumedMessageTimestamp}{`),
    response: [
        {
            metric: {
                consumergroup: `${repConfig.queueProcessor.groupId}-aws`,
                partition: '0',
            },
            value: [
                1557513858.92,
                '1557513660.261',
            ],
        },
        {
            metric: {
                consumergroup: `${repConfig.queueProcessor.groupId}-aws`,
                partition: '1',
            },
            value: [
                1557513858.92,
                '1557513660.307',
            ],
        },
        {
            metric: {
                consumergroup: `${repConfig.queueProcessor.groupId}-aws`,
                partition: '2',
            },
            value: [
                1557513858.92,
                '1557513660.309',
            ],
        },
    ],
}, {
    queryRegexp: new RegExp(
        `^sum\\(${queueMetricNames.kafkaConsumerGroupLag}{`),
    response: [
        {
            metric: {
                topic: lifecycleConfig.objectTasksTopic,
            },
            value: [
                1557513904.473,
                '15',
            ],
        },
        {
            metric: {
                topic: lifecycleConfig.bucketTasksTopic,
            },
            value: [
                1557513904.473,
                '30',
            ],
        },
    ],
}];

const MOCK_QUERY_NONEMPTY_RESPONSES_PHASE_2 = [{
    // this will match for each partition, so 3 times, values will be
    // summed in the final result
    queryRegexp: new RegExp(
        `sum\\(increase\\(${replicationMetricNames.replicationQueuedTotal}{`),
    response: [
        {
            metric: {},
            value: [
                1557514034.778,
                '2040.3339972221204',
            ],
        },
    ],
}, {
    // this will match for each partition, so 3 times, values will be
    // summed in the final result
    queryRegexp: new RegExp(
        `sum\\(increase\\(${replicationMetricNames.replicationQueuedBytes}{`),
    response: [
        {
            metric: {},
            value: [
                1557514112.092,
                '233098196.41634363',
            ],
        },
    ],
}];

const MOCK_QUERY_NONEMPTY_RESPONSES =
      MOCK_QUERY_NONEMPTY_RESPONSES_PHASE_1.concat(
          MOCK_QUERY_NONEMPTY_RESPONSES_PHASE_2);

const MOCK_QUERY_EMPTY_RESPONSES = [{
    queryRegexp: /.*/,
    response: [],
}];

const MOCK_QUERY_RESPONSES_WITH_ERROR_IN_PHASE_1 = [{
    queryRegexp: new RegExp(
        `^max\\(max\\(${queueMetricNames.latestPublishedMessageTimestamp}{`),
    error: true,
}, {
    queryRegexp: /.*/,
    response: [],
}];

// to trigger this error, we need a non-empty phase 1
const MOCK_QUERY_RESPONSES_WITH_ERROR_IN_PHASE_2 =
      MOCK_QUERY_NONEMPTY_RESPONSES_PHASE_1.concat([{
          queryRegexp: new RegExp(
              'sum\\(increase\\(' +
                  `${replicationMetricNames.replicationQueuedBytes}` +
                  '{.*partition=\"2\"'),
          error: true,
      }, {
          queryRegexp: /.*/,
          response: [],
      }]);

class PromAPIMock {
    constructor() {
        this._responseSet = null;
    }

    setResponseSet(responseSet) {
        this._responseSet = responseSet;
    }

    executeQuery(params, log, cb) {
        const match = this._responseSet.find(
            item => item.queryRegexp.exec(params.query) !== null);
        if (match) {
            if (match.error) {
                return process.nextTick(() => cb(errors.InternalError));
            }
            return process.nextTick(() => cb(null, match.response));
        }
        return assert.fail(`unexpected query: ${params.query}`);
    }
}

describe('LifecycleMetrics', () => {
    let promAPIMock;
    let lifecycleMetrics;
    before(() => {
        promAPIMock = new PromAPIMock();
        lifecycleMetrics = new LifecycleMetrics(promAPIMock);
    });

    it('should return lifecycle metrics from non-empty Prometheus queries ' +
    'results', done => {
        promAPIMock.setResponseSet(MOCK_QUERY_NONEMPTY_RESPONSES);
        lifecycleMetrics.getMetrics(log, (err, metrics) => {
            assert.ifError(err);
            assert.deepStrictEqual(metrics, {
                lifecycle: {
                    backlog: {
                        bucketTasks: {
                            count: 30,
                            ageSeconds: 421,
                            ageApprox: '7 minutes'
                        },
                        objectTasks: {
                            count: 15,
                            ageSeconds: 387,
                            ageApprox: '6 minutes'
                        },
                        transitions: {
                            aws: {
                                // 3x the mock value because queried
                                // for each of the 3 partitions
                                count: 6120,
                                bytes: 699294588,
                                ageSeconds: 1306,
                                ageApprox: '22 minutes'
                            },
                        },
                    },
                },
            });
            done();
        });
    });
    it('should return lifecycle metrics from empty Prometheus queries ' +
    'results', done => {
        promAPIMock.setResponseSet(MOCK_QUERY_EMPTY_RESPONSES);
        lifecycleMetrics.getMetrics(log, (err, metrics) => {
            assert.ifError(err);
            assert.deepStrictEqual(metrics, {
                lifecycle: {
                    backlog: {
                        bucketTasks: {
                            count: 0,
                            ageSeconds: 0,
                            ageApprox: '0 seconds'
                        },
                        objectTasks: {
                            count: 0,
                            ageSeconds: 0,
                            ageApprox: '0 seconds'
                        },
                        transitions: {},
                    },
                },
            });
            done();
        });
    });

    it('should carry error when prometheus returns an error in phase 1',
    done => {
        promAPIMock.setResponseSet(MOCK_QUERY_RESPONSES_WITH_ERROR_IN_PHASE_1);
        lifecycleMetrics.getMetrics(log, err => {
            assert(err);
            done();
        });
    });

    it('should carry error when prometheus returns an error in phase 2',
    done => {
        promAPIMock.setResponseSet(MOCK_QUERY_RESPONSES_WITH_ERROR_IN_PHASE_2);
        lifecycleMetrics.getMetrics(log, err => {
            assert(err);
            done();
        });
    });
});
