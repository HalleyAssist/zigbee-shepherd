/* jshint node: true */
'use strict';

var _ = require('busyman'),
    Ziee = require('ziee'),
    Endpoint = require('./endpoint');

class Device {
    constructor(devInfo){
        // devInfo = { type, ieeeAddr, nwkAddr, manufId, manufName, powerSource, modelId, epList }

        this._id = null;

        this.type = devInfo.type;
        this.ieeeAddr = devInfo.ieeeAddr;
        this.nwkAddr = devInfo.nwkAddr;
        this.manufId = devInfo.manufId;
        this.manufName = devInfo.manufName;
        this.powerSource = devInfo.powerSource;
        this.modelId = devInfo.modelId;

        this.status = 'offline';    // 'online', 'offline'
        this.joinTime = null;
        this._endpoints = {}        // key is epId in number, { epId: epInst, epId: epInst, ... }
        this.capabilities = devInfo.capabilities;
        this.incomplete = devInfo.incomplete === undefined ? true : devInfo.incomplete;

        this._initalizeEndpoints(devInfo)
    }

    get epList() {
        const ret = []
        for(const epId in this._endpoints){
            ret.push(parseInt(epId))
        }
        return ret
    }

    get endpoints(){
        const ret = {}
        for(const e in this._endpoints){
            const v = this._endpoints[e]
            if(v) ret[e] = v
        }
        return ret
    }


    set endpoints(value){
        // add new
        const existingKeys = Object.keys(value)
        for(const epId in value){
            const e = value[epId]
            if(e === null){
                if(!this._endpoints[epId]) this._endpoints[epId] = e
            }else{
                if(!(e instanceof Endpoint)){
                    throw new Error(`Endpoint proided of incorrect instance (${e})`)
                }
                this._endpoints[epId] = e
            }
        }

        // clear old
        for(const epId of existingKeys){
            if(value[epId] === undefined) delete this._endpoints[epId]
        }
    }
    
    getEndpointList(){
        const ret = []
        for(const e in this._endpoints){
            const v = this._endpoints[e]
            if(v) ret.push(v)
        }
        return ret
    }


    dumpEps(){
        const dumpOfEps = {};
        for(const epId in this._endpoints){
            const ep = this._endpoints[epId]
            if(ep){
                dumpOfEps[epId] = ep.dump()
            }else{
                dumpOfEps[epId] = null
            }
        }

        return dumpOfEps
    }

    dump(){
        const dumpOfEps = this.dumpEps()
        return {
            id: this._id,
            type: this.type,
            ieeeAddr: this.ieeeAddr,
            nwkAddr: this.nwkAddr,
            manufId: this.manufId,
            manufName: this.manufName,
            powerSource: this.powerSource,
            modelId: this.modelId,
            status: this.status,
            joinTime: this.joinTime,
            endpoints: dumpOfEps,
            capabilities: this.capabilities,
            incomplete: this.incomplete
        };
    }

    getEndpoint (epId) {
        return this.endpoints[epId];
    }
    
    getIeeeAddr () {
        return this.ieeeAddr;
    }
    
    getNwkAddr () {
        return this.nwkAddr;
    }
    
    getManufId () {
        return this.manufId;
    }
    
    update (info) {
        const infoKeys = [ 'type', 'ieeeAddr', 'nwkAddr', 'status', 'joinTime', 'manufId', 'manufName', 'modelId', 'powerSource', 'capabilities', 'incomplete' ]

        for(const key in info) {
            if (infoKeys.includes(key))
                this[key] = info[key];
        }

        if(info.endpoints){
            this.endpoints = info.endpoints
        }
    }

    _initalizeEndpoints(devInfo){
        if(!devInfo.endpoints) return
        for(const k in devInfo.endpoints){
            const v = devInfo.endpoints[k]
            if(v.isEndpoint && v.isEndpoint(true)){
                this._endpoints[k] = v
            }else{
                var ep = new Endpoint(this, v)
                ep.clusters = new Ziee();
                for(const cId in v.clusters){
                    const c = v.clusters[cId]
                    if(c.dir) ep.clusters.init(cId, 'dir', c.dir);
                    ep.clusters.init(cId, 'attrs', c.attrs, false);
                }
                this._endpoints[k] = ep
            }
        }
    }

    _recoverFromRecord (rec, shepherd) {
        this._recovered = true;
        this.status = 'offline';
        this._id = rec.id;

        if(this.type != "Coordinator"){
            for(const ep of this.getEndpointList()) {
                shepherd._attachZclMethods(ep)
            }
        }

        return this;
    }
}


module.exports = Device;
