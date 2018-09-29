/* jshint node: true */
'use strict';

var zdoHelper = require('./zdo_helper.js'),
    debug = require('debug')('zigbee-shepherd:event_bridge')

var bridge = {};

// Bridge functions for ZDO, SAPI, NWK
// Do nothing. No need to bridge: SYS, MAC, NWK, UTIL, DBG, APP
var subsysAreqBridge = { ZDO: zdoIndicationEventBridge, SAPI: sapiIndicationEventBridge, NWK: nwkIndicationEventBridge }

bridge.areqEventBridge = function (controller, msg) {
    // msg: { subsys: 'ZDO', ind: 'endDeviceAnnceInd', data: { srcaddr: 63536, nwkaddr: 63536, ieeeaddr: '0x00124b0001ce3631', ... }
    var mandatoryEvent = msg.subsys + ':' + msg.ind;    // 'SYS:resetInd', 'SYS:osalTimerExpired'

    controller.emit(mandatoryEvent, msg.data);          // bridge to subsystem events, like 'SYS:resetInd', 'SYS:osalTimerExpired'

    if (msg.subsys === 'AF')
        debug('IND <-- %s, transId: %d', mandatoryEvent, msg.data.transid || msg.data.transseqnumber);
    else
        debug('IND <-- %s', mandatoryEvent);

    // dispatch to specific event bridge
    subsysAreqBridge[msg.subsys](controller, msg)
};

function zdoIndicationEventBridge (controller, msg) {
    var payload = msg.data,
        zdoEventHead = 'ZDO:' + msg.ind,
        zdoBridgedEvent;

    if (msg.ind === 'stateChangeInd') {    // this is a special event
        if (!payload.hasOwnProperty('nwkaddr'))    // Coord itself
            zdoBridgedEvent = 'coordStateInd';
        else if (payload.state === 0x83 || payload.state === 'NOT_ACTIVE')
            zdoBridgedEvent = zdoEventHead + ':' + payload.nwkaddr + ':NOT_ACTIVE';
        else if (payload.state === 0x82 || payload.state === 'INVALID_EP')
            zdoBridgedEvent = zdoEventHead + ':' + payload.nwkaddr + ':INVALID_EP';
    } else {
        zdoBridgedEvent = zdoHelper.generateEventOfIndication(msg.ind, payload);
    }

    if (zdoBridgedEvent)
        controller.emit(zdoBridgedEvent, payload);
};

function sapiIndicationEventBridge (controller, msg) {
    var payload = msg.data,
        sapiEventHead = 'SAPI:' + msg.ind,
        sapiBridgedEvent;

    switch (msg.ind) {
        case 'bindConfirm':
            sapiBridgedEvent = sapiEventHead + ':' + payload.commandid;
            break;
        case 'sendDataConfirm':
            sapiBridgedEvent = sapiEventHead + ':' + payload.handle;
            break;
        case 'receiveDataIndication':
            sapiBridgedEvent = sapiEventHead + ':' + payload.source + ':' + payload.command;
            break;
        case 'findDeviceConfirm':
            if (payload.hasOwnProperty('result'))
                sapiBridgedEvent = sapiEventHead + ':' + payload.result;
            break;
        // startConfirm and allowBindConfirm need no bridging
    }

    if (sapiBridgedEvent)
        controller.emit(sapiBridgedEvent, payload);
}

function nwkIndicationEventBridge (controller, msg) {
    if (msg.ind == "pollInd") {
        controller.emit('NWK:' + msg.ind, msg.data);
    }
}

module.exports = bridge;
