/* jshint node: true */
'use strict';

const _ = require('busyman'),
     CCZnp = require('cc-znp'),
     ZSC = CCZnp.constants,
     debug = {
         shepherd: require('debug')('zigbee-shepherd'),
         init: require('debug')('zigbee-shepherd:init'),
         request: require('debug')('zigbee-shepherd:request'),
     }

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
    if (!this.controller.isResetting()) {
        if (msg !== '_reset'){
            if(!this._enabled){
                debug.shepherd('Skipping software reset (not started)...');
                return
            }
            debug.shepherd('Starting a software reset...');
        }

        if(this._enabled){
            await this.stop()
            await this.start()
        }
    }
    try {
        if (msg === '_reset')
            return this.controller.emit('_reset');
    }catch(err){
        if (msg === '_reset') {
            return this.controller.emit('_reset', err);
        } else {
            debug.shepherd('Reset had an error', err);
            this.emit('error', err);
        }
    }
};

handlers.leaveInd = async function (msg) {
    // { srcaddr, extaddr, request, removechildren, rejoin, status }

    this.emit('ZDO:leaveInd:'+msg.extaddr, msg);
    
    if(msg.status) {
        debug.shepherd('Device: %s not leaving due to %d status.', msg.srcaddr, msg.status);
        return
    }

    var dev = await this.findDevByAddr(msg.extaddr);

    if (dev) {
        var ieeeAddr = dev.getIeeeAddr(),
            epList = _.cloneDeep(dev.epList);

        if (msg.request)    // request
            await dev.delete()
        else    {
            // indication
            await dev.update({status: "offline", complete: false});
        }

        debug.shepherd('Device: %s leave the network.', ieeeAddr);
        this.emit('ind:leaving', epList, msg.nwkaddr, ieeeAddr);
    }else{
        this.emit('ind:leaving', epList, msg.srcaddr, msg.extaddr);
    }
};

handlers.stateChangeInd = function (msg) {
    // { state[, nwkaddr] }
    if (msg.nwkaddr===undefined)
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
