/* jshint node: true */
'use strict';

var Q = require('q'),
    debug = require('debug')('zigbee-shepherd:init');

var loader = require('../components/loader');

var init = {};

init.setupShepherd = function (shepherd, callback) {
    var deferred = Q.defer(),
        controller = shepherd.controller;

    debug('zigbee-shepherd booting...');

    controller.start().then(function () {
        return controller.request('ZDO', 'mgmtPermitJoinReq', { addrmode: 0x02, dstaddr: 0 , duration: 0, tcsignificance: 0 });
    }).then(function () {
        return shepherd._registerDev(controller.getCoord());
    }).then(function () {
        return loader.reload(shepherd);    // reload all devices from database
    }).then(function() {
        debug('Loading devices from database done.');
        debug('zigbee-shepherd is up and ready.');
    }).then(function () {
        var devs = shepherd._devbox.exportAllObjs();

		var result = Q();
        var promises = devs.filter(function(dev){
			return dev.getNwkAddr() !== 0;
		}).forEach(function(dev) {
            result.then(Q(function(){return Q.delay(3000)}).then(function(){console.log("delayed")}).then(controller.checkOnline(dev))) ;
        });
		
		return result;
    }).done(deferred.resolve, deferred.reject);

    return deferred.promise.nodeify(callback);
};

module.exports = init;
