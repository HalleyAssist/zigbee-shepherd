const Device = require('./device')

class JoiningDevice extends Device {
    constructor(keystore, devInfo, shepherd){
        super(keystore, devInfo, shepherd)

        this._updated = {}
    }
    
    async update (info) {
        Object.assign(this._updated, info)

        if(this._updated.complete){
            await super.update(this._updated)
            this._updated = {complete: this._updated.complete}
            return
        }

        const infoKeys = [ 'type', 'ieeeAddr', 'nwkAddr', 'status', 'joinTime', 'manufId', 'manufName', 'modelId', 'powerSource', 'capabilities', 'complete' ]

        for(const key in info) {
            if (infoKeys.includes(key))
                this._devInfo[key] = info[key];
        }

        if(info.endpoints){
            this.endpoints = info.endpoints
        }
    }
    async delete(){
        throw new Error('Invalid call to joining device delete')
    }
    async insert(){
        throw new Error('Invalid call to joining device insert')
    }

}
module.exports = JoiningDevice