/* jshint node: true */
'use strict';

var util = require('util'),
    Endpoint = require('./endpoint');

class Coordpoint extends Endpoint {
    // simpleDesc = { profId, epId, devId, inClusterList, outClusterList }
    constructor(coord, simpleDesc, isDelegator){
        // coordpoint is a endpoint, but a 'LOCAL' endpoint
        // This class is used to create delegators, local applications
        super(coord, simpleDesc)
        this._isDelegator = isDelegator
    }

    isLocal () {
        return true;                      // this is a local endpoint, always return true
    }

    isDelegator () {
        return !!this._isDelegator;  // this local endpoint maybe a delegator
    }
}

module.exports = Coordpoint;
