'use strict'; // eslint-disable-line
const werelogs = require('werelogs');
const { initManagement } = require('../../../lib/management');
const LifecycleProducer = require('./LifecycleProducer');
const { zookeeper, kafka, extensions, s3, transport, log } =
      require('../../../conf/Config');

werelogs.configure({ level: log.logLevel,
                     dump: log.dumpLevel });

const logger = new werelogs.Logger('Backbeat:Lifecycle:Producer');

const lifecycleProducer =
    new LifecycleProducer(zookeeper, kafka, extensions.lifecycle,
                          s3, transport);

function initAndStart() {
    initManagement({
        serviceName: 'lifecycle',
        serviceAccount: extensions.lifecycle.auth.account,
    }, error => {
        if (error) {
            logger.error('could not load management db',
                         { error: error.message });
            setTimeout(initAndStart, 5000);
            return;
        }
        logger.info('management init done');

        lifecycleProducer.start();
    });
}

initAndStart();

process.on('SIGTERM', () => {
    logger.info('received SIGTERM, exiting');
    lifecycleProducer.close(() => {
        process.exit(0);
    });
});
