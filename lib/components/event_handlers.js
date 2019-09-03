/* jshint node: true */
'use strict';

var Q = require('q'),
    _ = require('busyman'),
    ZSC = require('zstack-constants'),
    debug = {
        shepherd: require('debug')('zigbee-shepherd'),
        init: require('debug')('zigbee-shepherd:init'),
        request: require('debug')('zigbee-shepherd:request'),
    };

var handlers = {}, event_handlers = {};

event_handlers.attachEventHandlers = function (shepherd) {
    var controller = shepherd.controller,
        hdls = {};

    _.forEach(handlers, function (hdl, key) {
        if (key !== 'attachEventHandlers')
            hdls[key] = hdl.bind(shepherd);
    });

    controller.removeListener('SYS:resetInd',          hdls.resetInd);
    controller.removeListener('ZDO:stateChangeInd',    hdls.stateChangeInd);
    controller.removeListener('ZDO:statusErrorRsp',    hdls.statusErrorRsp);
    controller.removeListener('ZDO:leaveInd',          hdls.leaveInd);

    controller.on('SYS:resetInd',          hdls.resetInd);
    controller.on('ZDO:stateChangeInd',    hdls.stateChangeInd);
    controller.on('ZDO:statusErrorRsp',    hdls.statusErrorRsp);
    controller.on('ZDO:leaveInd',          hdls.leaveInd);
};

/*************************************************************************************************/
/*** Event Handlers                                                                            ***/
/*************************************************************************************************/
handlers.resetInd = async function (msg) {
    var self = this;

    if (this.controller.isResetting()) return;

    if (msg !== '_reset')
        debug.shepherd('Starting a software reset...');

    if(this._enabled){
        await this.stop()
        await this.start()
    }
    try {
        if (msg === '_reset')
            return self.controller.emit('_reset');
    }catch(err){
        if (msg === '_reset') {
            return self.controller.emit('_reset', err);
        } else {
            debug.shepherd('Reset had an error', err);
            self.emit('error', err);
        }
    }
};

handlers.leaveInd = function (msg) {
    // { srcaddr, extaddr, request, removechildren, rejoin }
    var dev = this._findDevByAddr(msg.extaddr);

    if (dev) {
        var ieeeAddr = dev.getIeeeAddr(),
            epList = _.cloneDeep(dev.epList);

        if (msg.request)    // request
            this._unregisterDev(dev);
        else    {
            // indication
            dev.update({status: "offline", incomplete: true});
            return Q.ninvoke(this._devbox, 'sync', dev._getId());
        }

        debug.shepherd('Device: %s leave the network.', ieeeAddr);
        this.emit('ind:leaving', epList, msg.nwkaddr, ieeeAddr);
    }else{
        this.emit('ind:leaving', epList, msg.srcaddr, msg.extaddr);
    }
};

handlers.stateChangeInd = function (msg) {
    // { state[, nwkaddr] }
    if (!msg.hasOwnProperty('nwkaddr'))
        return;

    var devStates = msg.state;

    _.forEach(ZSC.ZDO.devStates, function (statesCode, states) {
        if (msg.state === statesCode)
            devStates = states;
    });

    debug.shepherd('Device: %d is now in state: %s', msg.nwkaddr, devStates);
};

handlers.statusErrorRsp = function (msg) {
    // { srcaddr, status }
    debug.shepherd('Device: %d status error: %d', msg.srcaddr, msg.status);
};

module.exports = event_handlers;
