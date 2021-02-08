const SerialPort = require('serialport');
const InterByteTimeout = require('@serialport/parser-inter-byte-timeout');
const CRC = require('crc-full').CRC;
var crcCalculator = new CRC('CRC8', 8, 0x07, 0xf3, 0x00, false, false);

console.log('Setting up port...');
const port = new SerialPort('/dev/ttyUSB0', {
    autoOpen: false,
    baudRate: 19200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1
});

var toSend;

console.log('Initiating parser...');
const parser = port.pipe(new InterByteTimeout({ interval: 1, maxBufferSize: 16 }));
parser.on('data', (buffer) => {
    const crc = crcCalculator.compute(buffer.slice(1, buffer.length - 1));
    if (crc !== buffer[buffer.length - 1]) {
        console.error(`Bad CRC check\t ${buffer.toString('hex')} :${crc.toString(16)}`);
    } else {
        switch (buffer[1]) {
            case 0: // Broadcast status
                console.log(`Broadcast\t ${buffer.toString('hex')}`);
                break;
    
            default:
                console.log(`Unknown ${buffer.length}\t ${buffer.toString('hex')}`);
                break;
        }
    }

    // If we have something to send out, do it now
    if (Buffer.isBuffer(toSend) && toSend.length > 0) {
        console.log(`Sending ${toSend.length}\t ${toSend.toString('hex')}`);
        toSend = undefined;
    }
});

console.log('Opening port...');
port.open(function (err) {
    if (err) {
        return console.log('Error opening port: ', err.message)
    }
});
