import express from "express";
import https from "httpolyglot";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";

import mediasoup from "mediasoup";

const __dirname = path.resolve();

const app = express();

app.get("/", (req, res) => {
  res.send("Hello from mediasoup app!");
});

app.use("/sfu", express.static(path.join(__dirname, "public")));

// const options = {
//   key: fs.readFileSync("./server/ssl/key.pem", "utf8"),
//   cert: fs.readFileSync("./server/ssl/cert.pem", "utf8"),
// };

// const httpsServer = https.createServer(options, app);
// httpsServer.listen(3000, () => {
//   console.log("Server is running on port 3000");
// });

const wss = new WebSocketServer({ port: 8080 });

let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMaxPort: 2020,
    rtcMinPort: 2000,
  });

  console.log(`worker pid: ${worker.pid}`);

  worker.on("died", (err) => {
    console.error("Mediasoup worker died", err.message);
    setTimeout(() => process.exit(1), 2000);
  });
};

createWorker();

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    preferredPayloadType: 127,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

wss.on("connection", async function connection(socket) {
  console.log(socket.id);
  socket.emit("connection-success", {
    socketId: socket.id,
  });

  socket.on("disconnect", () => {
    console.log(`user disconnected with socket id: ${socket.id}`);
  });

  router = await worker.createRouter({ mediaCodecs });

  socket.on("message", async function message(message) {
    console.log("received: %s", message);

    const { type, data } = JSON.parse(message);

    switch (type) {
      case "getRtpCapabilities":
        console.log("Getting router capabilities");
        const rtpCapabilities = router.rtpCapabilities;
        console.log("getRtpCapabilities: Fetching rtpCapabilities");
        const rtpCapabilitiesResponse = {
          rtpCapabilities: rtpCapabilities,
        }
        const responseData = JSON.stringify({
          type: "getRtpCapabilities",
          data: rtpCapabilitiesResponse,
        });
        socket.send(responseData);
        break;

      case "createWebRtcTransport":
        console.log("Creating WebRTC Transport");
        const params = await onCreateWebRtcTransport(data);
        const createWebRtcTransportResponseData = JSON.stringify({
          type: "createWebRtcTransport",
          data: params,
        });
        socket.send(createWebRtcTransportResponseData);
        break;

      case "transport-connect":
        await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
        break;

      case "transport-recv-connect":
        await consumerTransport.connect({ dtlsParameters: data.dtlsParameters  });
        break;

      case "transport-produce":
        console.log('EVENT: Transport-produce');
        producer = await producerTransport.produce({
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        });
  
        console.log(
          "Producer Id: ",
          producer.id,
          "Producer Kind: ",
          producer.kind
        );
  
        producer.on("transportclose", () => {
          console.log("transport for this producer closed");
          producer.close();
        });
        
        socket.send(JSON.stringify({type: "transport-produce", data: {id: producer.id}}));
        break;

      case "consume":
        console.log('EVENT: consume');
        console.log('RtpParameters received: ', data.rtpCapabilities);

        const canConsume = router.canConsume({
          producerId: producer.id,
          rtpCapabilities: data.rtpCapabilities,
        });

        console.log("rtpCapabilities", data.rtpCapabilities, " canConsume: ", canConsume);

        try {
          if (canConsume) {
            console.log("creating consumer");
            consumer = await consumerTransport.consume({
              producerId: producer.id,
              rtpCapabilities: data.rtpCapabilities,
              paused: true,
            });
    
            consumer.on("transportclose", () => {
              console.log("transport close from consumer");
            });
    
            consumer.on("producerclose", () => {
              console.log("producer of consumer closed");
            });
    
            const params = {
              id: consumer.id,
              producerId: producer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
            };

            console.log("RTP Parameters: ", JSON.stringify(consumer.rtpParameters));
            
            socket.send(JSON.stringify({type: "consume", data: {params: params}}));
          }
        } catch (error) {
          console.log(error.message);
          socket.send(JSON.stringify({type: "consume", data: {
            params: { 
              error: error
            }
          }
        }));
        }
        break;
      
      case "consumer-resume":
        await consumer.resume();
        break;
    }

    // console.log({ rtpCapabilities });
  });

  socket.on("getRtpCapabilities", () => {
    console.log("Getting router capabilities");
    const rtpCapabilities = router.rtpCapabilities;
    console.log("getRtpCapabilities: Fetching rtpCapabilities");
    // callback({ rtpCapabilities });
    socket.emit("getRtpCapabilities", { rtpCapabilities });
  });

  const onCreateWebRtcTransport = async ({ sender }) => {
    console.log(`Is this a sender request? ${sender}`);

    const {params, transport} = await createWebRtcTransport();

    if (sender) producerTransport = transport
    else consumerTransport = transport;

    return params;
  };

  socket.on("transport-connect", async ({ transportId, dtlsParameters }) => {
    console.table({ transportId, dtlsParameters });
    console.log("dtlsParameters", dtlsParameters);

    await producerTransport.connect({ dtlsParameters });
  });

  socket.on(
    "transport-produce",
    async ({ transportId, kind, rtpParameters, appData }, callback) => {
      producer = await producerTransport.produce({
        kind,
        rtpParameters,
      });

      console.log(
        "Producer Id: ",
        producer.id,
        "Producer Kind: ",
        producer.kind
      );

      producer.on("transportclose", () => {
        console.log("transport for this producer closed");
        producer.close();
      });

      callback({ id: producer.id });
    }
  );

  socket.on(
    "transport-recv-connect",
    async ({ transportId, dtlsParameters }) => {
      console.log("DTLS Params: ", dtlsParameters);
      await consumerTransport.connect({ dtlsParameters });
    }
  );

  socket.on("consume", async ({ rtpCapabilities }, callback) => {
    console.log("received consume req");
    console.log(
      "rtpCapabilities",
      rtpCapabilities,
      "producer id: ",
      producer.id
    );
    const canConsume = router.canConsume({
      producerId: producer.id,
      rtpCapabilities,
    });

    console.log("canConsume", canConsume);
    try {
      if (canConsume) {
        console.log("creating consumer");
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        });

        consumer.on("transportclose", () => {
          console.log("transport close from consumer");
        });

        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
        });

        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };

        callback({ params });
      }
    } catch (error) {
      console.log(error.message);
      callback({
        params: {
          error: error,
        },
      });
    }
  });

  socket.on("consumer-resume", async () => {
    console.log("consumer resume");
    await consumer.resume();
  });
});

const createWebRtcTransport = async () => {
  try {
    const webRtcListenOptions = {
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: "127.0.0.1",
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    };

    let transport = await router.createWebRtcTransport(webRtcListenOptions);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("close", () => {
      console.log("transport closed");
    });

    const params = {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    }
    
    // console.log("DTLS Parameters: " + JSON.stringify(transport.dtlsParameters));
    // console.log("createWebRtcTransport response: ", params);

    return {params, transport};
  } catch (error) {
    console.log(error);
  }
};
