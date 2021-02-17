# hormann-hcp
Experiments with the Hormann HCP bus

Inspired by https://blog.bouni.de/2018/reverse-engeneering-the-hormann-uap1-protocoll.html

Seems to be working just fine with LineaMatic P motor. Test experiment responds instantly to keyboard input.

# Setup

make sure you've git, nodejs and npm installed

```
git clone https://github.com/raintonr/hormann-hcp.git

cd hormann-hcp

npm install
```

# Usage

make sure you have your USB/RS485 dongle connected and it is showing up as `/dev/ttyUSB0`.

start the program with `nodejs hormann-hcp.js`

You then get some debug output like this:

```
Setting up port...
Initiating parser...
Opening port...
```

To send commands you can press the number keys 1 up to 8 on your keyboard.

