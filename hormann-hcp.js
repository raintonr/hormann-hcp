const SerialPort = require('serialport');
const InterByteTimeout = require('@serialport/parser-inter-byte-timeout');

console.log('Setting up port...');
const port = new SerialPort('/dev/ttyUSB0', {
    autoOpen: false,
    baudRate: 19200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1
});

console.log('Initiating parser...');
const parser = port.pipe(new InterByteTimeout({ interval: 1, maxBufferSize: 16 }));
parser.on('data', (buffer) => {
    switch (buffer[1]) {
        case 0: // Broadcast status
            console.log(`Broadcast\t ${buffer.toString('hex')}`);
            break;

        default:
            console.log(`Unknown ${buffer.length}\t ${buffer.toString('hex')}`);
            break;
    }
});

console.log('Opening port...');
port.open(function (err) {
    if (err) {
        return console.log('Error opening port: ', err.message)
    }
});
