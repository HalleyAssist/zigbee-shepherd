/* jshint node: true */
'use strict';

const Device = require('./device');

class Coordinator extends Device {
    constructor(devInfo){
        const info = Object.assign({}, devInfo)
        delete info.endpoints
        super(info);

        this.status = 'online';
        this.incomplete = false;
    }

    getDelegator (profId = null) {
        for(const ep of this.getEndpointList()){
            if(ep.isDelegator() && (!profId || ep.getProfId() === profId)) return ep
        }
    }

    _initalizeEndpoints(devInfo){}
}

module.exports = Coordinator;
