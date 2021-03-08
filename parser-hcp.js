const { Transform } = require('stream');
const CRC = require('crc-full').CRC;

// Timespan with no data before we consider a new packet starts (nanoseconds);
const packetInterval = BigInt(200000);

// What's the maximum length message we think should be handled?
const maxMessageLength = 3;

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
        this.promiscuous = options.promiscuous;
        this.lastChunk = BigInt(0);
        this._clearPacket();
    }
    _clearPacket() {
        this.currentPacket = [];
        this.currentPacketEnd = 0;
        this.currentPacketInProgress = false;
        this.packetTime = BigInt(0);
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
        //  console.log(`\t\t\t\t\t+${delay}\tNew chunk (${chunk.length})\t${chunk.toString('hex')}`);
        const byte = chunk[0];

        if (delay > packetInterval && !this.currentPacketInProgress) {
            // Transmission window passed, start a new packet
            this.packetTime = process.hrtime.bigint();
            this.currentPacketInProgress = true;
        }
        /*
         * Tricky situation...
         *
         * On some USB UART devices seems the 'break' that each packet starts with is interpreted
         * as an error (guessing?) and a zero value byte is thrown out here.
         *
         * On some other UART devices this doesn't seem to happen, but don't know how to detect that
         * and therefore how to detect 'break' on these.
         *
         * So we have to assume that a packet will sometimes have an extra zero value byte at the start
         */
        if (this.currentPacketInProgress) {
            const byteSeq = this.currentPacket.length;
            if (byteSeq === 0) {
                // Stash this as the first byte in our buffer.
                // console.log(`\t\tNew packet starting ${byte.toString('16')}`);
                this.currentPacket.push(byte);
            } else if (byteSeq === 1) {
                // Counter/message length
                // High nibble == counter. TODO: ignore for now
                // Low nibble == length
                var currentMessageLength = byte & 0x0f;

                // If the length looks dodgy and & the starting byte was zero let's assume
                // the starting byte we had was a result of BRK and replace it.
                if (this.currentPacket[0] === 0 && (
                    byte === 0 || currentMessageLength > maxMessageLength)) {
                    // console.log(`\t\tLooks like a premature start to packet, replacing with ${byte.toString('16')}`);
                    this.currentPacket[0] = byte;
                } else {
                    // Looks good
                    // So last byte of this message will be...
                    this.currentPacketEnd = currentMessageLength + byteSeq + 1;
                    // console.log(`\t\tCurrent packet will end byte ${this.currentPacketEnd}`);
                    this.currentPacket.push(byte);
                }
            } else if (byteSeq < this.currentPacketEnd) {
                // console.log(`\t\tData: ${byte}`);
                this.currentPacket.push(byte);
            } else {
                // Last byte of message - this is CRC
                const crc = this.computeCRC(this.currentPacket);
                if (byte !== crc) {
                    console.error(`\t\tCRC: ${byte} != ${crc}`);
                } else if (this.promiscuous || this.currentPacket[0] === 0 || this.currentPacket[0] === this.receiveAddress) {
                    // Promiscuous mode, broadcast packet or for receive address
                    this.emitPacket();
                }
                this._clearPacket();
            }
        }
        cb();
    }
    emitPacket() {
        if (this.currentPacket.length > 0) {
            this.push(Buffer.from(this.currentPacket))
        }
    }
    _flush(cb) {
        this.emitPacket();
        cb();
    }
    computeCRC(bytes) {
        return this.crcCalculator.compute(bytes);
    }
    getPacketTime() {
        return this.packetTime;
    }
}

module.exports = HCPParser