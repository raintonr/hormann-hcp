const { Transform } = require('stream');
const CRC = require('crc-full').CRC;

// Timespan with no data before we consider a new packet starts (nanoseconds);
const packetInterval = BigInt(7000000);

class HCPParser extends Transform {
    constructor(options) {
        super()
        options = { maxBufferSize: 16, ...options }

        if (typeof options.maxBufferSize !== 'number' || Number.isNaN(options.maxBufferSize)) {
            throw new TypeError('"maxBufferSize" is not a number')
        }

        if (options.maxBufferSize < 1) {
            throw new TypeError('"maxBufferSize" is not greater than 0')
        }

        this.crcCalculator = new CRC('CRC8', 8, 0x07, 0xf3, 0x00, false, false);

        this.maxBufferSize = options.maxBufferSize;
        this.receiveAddress = options.receiveAddress;
        this.lastChunk = BigInt(0);
        this._clearPacket();
    }
    _clearPacket() {
        this.currentPacket = [];
        this.currentMessageEnd = 0;
        this.currentPacketInProgress = false;
    }
    _dataDelay() {
        // Work out delay since last message
        const dataTime = process.hrtime.bigint();
        const dataDelay = dataTime - this.lastChunk;
        this.lastChunk = dataTime;
        return dataDelay;
    }
    _transform(chunk, encoding, cb) {
        const delay = this._dataDelay();
//        console.log(`+${delay}\tNew chunk (${chunk.length})\t${chunk.toString('hex')}`);
        const byte = chunk[0];
        
        if (delay > packetInterval) {
            // Transmission window passed, start a new packet
            if (byte !== 0) {
                console.error(`\t\tStart packet with non-zero?!`);
            } else {
//                console.log(`\t\tStart packet`);
                this.currentPacketInProgress = true;
            }
        } else if (this.currentPacketInProgress) {
            const byteSeq = this.currentPacket.length;
            if (byteSeq === 0) {
                // Receiving address
                if (byte === 0 || byte === this.receiveAddress) {
                    // Broadcast or for us
//                    console.log(`\t\tCurrent packet is of interest (${byte})`);
                    this.currentPacket.push(byte);
                } else {
                    // We don't care - bin this
//                    console.log(`\t\tIgnore address ${byte}`);
                    this._clearPacket();
                }
            } else if (byteSeq === 1) {
                // Counter/message length
                // High nibble == counter. TODO: ignore for now
                // Low nibble == length
                this.currentMessageEnd = byte & 0x0f;
                // So last byte of this message will be...
                this.currentMessageEnd += byteSeq + 1;
//                console.log(`\t\tCurrent packet will end byte ${this.currentMessageEnd}`);
                this.currentPacket.push(byte);
            } else if (byteSeq < this.currentMessageEnd) {
//                console.log(`\t\tData: ${byte}`);
                this.currentPacket.push(byte);
            } else {
                // Last byte of message - this is CRC
                const crc = this.crcCalculator.compute(this.currentPacket);
                if (byte === crc) {
                    this.emitPacket()
                } else {
                    console.error(`\t\tCRC: ${byte} != ${crc}`);
                    this._clearPacket();
                }
            }
        }
        cb();
    }
    emitPacket() {
        //        console.log(`Time to emit (${this.currentPacket.length})\t${this.currentPacket.toString('hex')}`);
        if (this.currentPacket.length > 0) {
            this.push(Buffer.from(this.currentPacket))
            this._clearPacket();
        }
    }
    _flush(cb) {
        this.emitPacket();
        cb();
    }
}

module.exports = HCPParser