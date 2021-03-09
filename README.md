# hormann-hcp

Experiments with the Hormann HCP bus.

Inspired by https://blog.bouni.de/posts/2018/hoerrmann-uap1/

Tested and working just fine with LineaMatic P motor and the following platform combinations:

- Lenovo X220 laptop + USB FTDI RS232 + TTL to 485 converter module.
- Lenovo X220 laptop + USB 485 adapter.
- Raspberry Pi 3B plus + USB FTDI RS232 + TTL to 485 converter module.
- Raspberry Pi 3B plus + built in UART + TTL to 485 converter module.

Test experiment responds instantly to keyboard input using this code.

# Setup

Should works with any Linux serial device. Make sure kernel modules are loaded and your serial device is showing up in `/dev` tree.

Install git, nodejs, npm & friends, then:

```
git clone https://github.com/raintonr/hormann-hcp.git

cd hormann-hcp

npm install
```

# Usage

Assumes you have a USB/RS485 dongle connected and available as `/dev/ttyUSB0`. If not, edit the test code to update the path for your device. Ie `/dev/ttyAMA0` for Raspberry Pi built in UART (noting this requires a TTL to 485 converter).

Start the program with `npm start`

You then get a couple of messages like this:

```
Setting up port...
Opening port...
```

To send commands you can press the number keys 1 up to 8 on your keyboard.

# Debug

Uses node `debug` module with prefix `hormann-hcp:` so enable all debugging with:

`DEBUG=hormann-hcp:* npm start`
