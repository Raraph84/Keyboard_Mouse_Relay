const dbus = require("dbus-native");

const getBluetoothInputHostPaths = async () => {

    const bus = dbus.systemBus();

    const objManager = await new Promise((resolve) => bus.getService("org.bluez").getInterface("/", "org.freedesktop.DBus.ObjectManager", (error, objManager) => {
        if (error) throw error;
        resolve(objManager);
    }));

    const objs = await new Promise((resolve) => objManager.GetManagedObjects((error, objs) => {
        if (error) throw error;
        resolve(objs);
    }));

    const inputObj = objs.find((obj) => JSON.stringify(obj[1]).includes("org.bluez.InputHost1"));
    if (!inputObj) return null;

    const inputHost = await new Promise((resolve) => bus.getService("org.bluez").getInterface(inputObj[0], "org.bluez.InputHost1", (error, inputHost) => {
        if (error) throw error;
        resolve(inputHost);
    }));

    const socketPathCtrl = await new Promise((resolve) => inputHost.$readProp("SocketPathCtrl", (error, path) => {
        if (error) throw error;
        resolve(path);
    }));

    const socketPathIntr = await new Promise((resolve) => inputHost.$readProp("SocketPathIntr", (error, path) => {
        if (error) throw error;
        resolve(path);
    }));

    return { control: socketPathCtrl, interrupt: socketPathIntr };
};

const decodeMouse = (bytes) => {
    const button = bytes[1];
    const hex = bytes.slice(2, 5).toString("hex");
    const hex1 = parseInt(hex[3] + hex[0] + hex[1], 16);
    const hex2 = parseInt(hex[4] + hex[5] + hex[2], 16);
    const x = hex1 < 2048 ? hex1 : hex1 - 4096;
    const y = hex2 < 2048 ? hex2 : hex2 - 4096;
    const yScroll = bytes[5] < 128 ? bytes[5] : bytes[5] - 256;
    const xScroll = bytes[6] < 128 ? bytes[6] : bytes[6] - 256;
    return { button, x, y, yScroll, xScroll };
};

const encodeMouse = (button, x, y, yScroll, xScroll) => {
    const hex1 = (x < 0 ? x + 4096 : x).toString(16).padStart(3, "0");
    const hex2 = (y < 0 ? y + 4096 : y).toString(16).padStart(3, "0");
    const hex = hex1 + hex2;
    const yScrollByte = yScroll < 0 ? yScroll + 256 : yScroll;
    const xScrollByte = xScroll < 0 ? xScroll + 256 : xScroll;
    return [5, button, parseInt(hex[1] + hex[2], 16), parseInt(hex[5] + hex[0], 16), parseInt(hex[3] + hex[4], 16), yScrollByte, xScrollByte];
};

const decodeModifiers = (byte, map) => {
    const modifiers = [];
    for (let value in map) {
        value = parseInt(value);
        if ((byte & value) !== 0) modifiers.push(map[value]);
    }
    return modifiers;
};

const decodeKeys = (bytes, keymap) => {
    const pressedKeys = [];
    for (let i = 2; i < bytes.length; i++) {
        const keyCode = bytes[i];
        if (keyCode === 0x01) return null;
        if (keyCode !== 0) {
            const key = keymap.keys[keyCode];
            if (key) pressedKeys.push(key);
        }
    }
    return pressedKeys;
};

const encodeKeys = (pressedKeys, keymap) => {

    const keys = [1, 0, 0];
    const media = [2, 0, 0, 0];
    for (const key of pressedKeys) {
        for (const k in keymap.keys)
            if (keymap.keys[k] === key)
                keys.push(parseInt(k));
        for (const k in keymap.modifiers)
            if (keymap.modifiers[k] === key)
                keys[1] |= parseInt(k);
        for (const k in keymap.media1)
            if (keymap.media1[k] === key)
                media[1] |= parseInt(k);
        for (const k in keymap.media2)
            if (keymap.media2[k] === key)
                media[2] |= parseInt(k);
        for (const k in keymap.media3)
            if (keymap.media3[k] === key)
                media[3] |= parseInt(k);
    }
    while (keys.length < 9) keys.push(0);

    return { keys, media };
};

const toByte = (value) => value < 0 ? 256 + value : value;
const fromByte = (byte) => byte > 128 ? byte - 256 : byte;

module.exports = {
    getBluetoothInputHostPaths,
    decodeMouse,
    encodeMouse,
    decodeModifiers,
    decodeKeys,
    encodeKeys,
    toByte,
    fromByte
};
