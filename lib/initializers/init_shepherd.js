/* jshint node: true */
'use strict';

var af = require('../components/af'),
    loader = require('../components/loader'),
    debug = require('debug')('zigbee-shepherd:init')

var init = {};

init.setupShepherd = function (shepherd, callback) {
    var controller = shepherd.controller,
        netInfo;

    debug('zigbee-shepherd booting...');

    shepherd.af = af(controller);
    return controller.start().then(function () {
        return controller.request('ZDO', 'mgmtPermitJoinReq', { addrmode: 0x02, dstaddr: 0 , duration: 0, tcsignificance: 0 });
    }).then(function () {
        var now = new Date()
        return controller.request('SYS', 'setTime',
         { utc: 0, year:now.getUTCFullYear(), month:now.getUTCMonth() + 1, day:now.getUTCDate(), 
            hour:now.getUTCHours(), minute:now.getUTCMinutes(), second:now.getUTCSeconds() });
    }).then(function () {
        return shepherd._registerDev(controller.getCoord());
    }).then(function () {
        return loader.reload(shepherd);    // reload all devices from database
    }).then(function() {
        netInfo = controller.getNetInfo();

        debug('Loading devices from database done.');
        debug('zigbee-shepherd is up and ready.');
        
        debug('Network information:');
        debug(' >> State:      %s', netInfo.state);
        debug(' >> Channel:    %s', netInfo.channel);
        debug(' >> PanId:      %s', netInfo.panId);
        debug(' >> Nwk Addr:   %s', netInfo.nwkAddr);
        debug(' >> Ieee Addr:  %s', netInfo.ieeeAddr);
        debug(' >> Ext. PanId: %s', netInfo.extPanId);
    }).nodeify(callback)
};

module.exports = init;
