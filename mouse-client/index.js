const net = require("net");
const provider = process.platform === "win32" ? require("../libnut-core") : require("robotjs");

require("dotenv").config();

provider.setMouseDelay(0);

let lastButton = null;
const handle = (data) => {

    const split = data.split(" ");
    if (split[0] === "0") {

        const x = parseInt(split[1]);
        const y = parseInt(split[2]);

        const old = provider.getMousePos();
        provider.moveMouse(old.x + x, old.y + y);

    } else if (split[0] === "1") {

        const button = { 1: "left", 2: "right", 4: "middle" }[split[1]];
        if (button && lastButton !== button) {
            if (lastButton) provider.mouseToggle("up", lastButton);
            provider.mouseToggle("down", button);
            lastButton = button;
        } else if (lastButton) {
            provider.mouseToggle("up", lastButton);
            lastButton = null;
        }

        if (split[2] !== "0" || split[3] !== "0") {

            const yScroll = parseInt(split[2]);
            const xScroll = 0 - parseInt(split[3]);

            if (process.platform === "win32") provider.scrollMouse(xScroll * 144, yScroll * 144);
            else provider.scrollMouse(xScroll, yScroll);
        }
    }
};

const connect = () => {

    const client = new net.Socket();
    client.connect(process.env.SERVER_PORT, process.env.SERVER_HOST);
    client.on("connect", () => {
        client.write(JSON.stringify({ token: process.env.TOKEN, type: "mouse" }) + "\n");
        console.log("Connected to the server.");
    });
    client.on("close", () => {
        console.log("Disconnected from the server, reconnecting...");
        setTimeout(connect, 500);
    });
    client.on("error", () => { });

    let data = "";
    client.on("data", (chunk) => {
        data += chunk;
        while (data.includes("\n")) {
            const dataSplit = data.split("\n");
            handle(dataSplit.shift());
            data = dataSplit.join("\n");
        }
    });
};

connect();
