/* jshint node: true */
'use strict';

const Device = require('./device'),
      CoordPoint = require('./coordpoint')

class Coordinator extends Device {
    constructor(keystore, devInfo = {}){
        devInfo = Object.assign({}, devInfo)
        delete devInfo.endpoints

        devInfo.status = 'online';
        devInfo.complete = true;

        super(keystore, devInfo);
    }

    getDelegator (profId = null) {
        for(const ep of this.getEndpointList()){
            if(ep.isDelegator() && (!profId || ep.getProfId() === profId)) return ep
        }
    }
    _endpoint(v,epId){
        return new CoordPoint(this, v, epId <= 10, this.shepherd)
    }

    _initalizeEndpoints(devInfo){}
}

module.exports = Coordinator;
