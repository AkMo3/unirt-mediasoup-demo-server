const io = require("socket.io-client");
const mediasoupClient = require("mediasoup-client");

const socket = io("/mediasoup");

socket.on("connection-success", (socketId) => {
  console.log(socketId);
});

let params = {
  encodings: [
    {
      rid: 'r0',
      maxBitrate: 100000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r1',
      maxBitrate: 300000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r2',
      maxBitrate: 900000,
      scalabilityMode: 'S1T3',
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000
  }
};

let device;
let rtpCapabilities;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const streamSuccess = async (stream) => {
  console.log("streamSuccess: Fetching local stream");
  const localVideo = document.getElementById("localVideo");
  console.log("localVideo", localVideo);
  localVideo.srcObject = stream;
  localVideo.play();
  const track = stream.getVideoTracks()[0];
  params = {
    track,
    ...params,
  };
};

const getLocalStream = () => {
  console.log("getLocalStream: Getting local stream");
  navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: {
        width: {
          min: 640,
          max: 1920,
        },
        height: {
          min: 400,
          max: 1080,
        },
      },
    })
    .then(streamSuccess)
    .catch((err) => console.error("getUserMediaError", err));
};

const getRtpCapabilities = async () => {
  console.log("getRtpCapabilities: Fetching rtpCapabilities");
  socket.emit("getRtpCapabilities", (data) => {
    console.log(`Router RTP Capabilities... ${data}`, data);

    rtpCapabilities = data.rtpCapabilities;
  });
};

const createDevice = async () => {
  try {
    device = new mediasoupClient.Device();

    await device.load({ routerRtpCapabilities: rtpCapabilities });

    console.log("RTP Capabilities", device.rtpCapabilities);
  } catch (err) {
    console.error(err);
    if (err.name === "UnsupportedError") {
      console.warn("createDevice: UnsupportedError, browser not supported");
    }
  }
};

const createSendTransport = () => {
  socket.emit("createWebRtcTransport", { sender: true }, ({ params }) => {
    
    if (params.error) {
      console.log(params.error);
      return;
    }
    
    console.log(params);

    producerTransport = device.createSendTransport(params);

    producerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local dtlsParameters to the server side transport
          await socket.emit("transport-connect", {
            transportId: producerTransport.id,
            dtlsParameters: dtlsParameters,
          });

          // Tell the transport that parameters were transmitted
          callback();
        } catch (error) {
          errback(error);
        }
      }
    );

    producerTransport.on("produce", async (parameters, callback, errback) => {
      console.log(parameters);

      try {
        await socket.emit(
          "transport-produce",
          {
            transportId: producerTransport.id,
            kind: parameters.kind,
            rtpParameters: parameters.rtpParameters,
            appData: parameters.appData,
          },
          ({ id }) => {
            callback({ id });
          }
        );
      } catch (err) {
        errback(err);
      }
    });
  });
};

const connectSendTransport = async () => {
  producer = await producerTransport.produce(params);
  producer.on('trackended', () => {
    console.log('track ended');
  })

  producer.on('transportclose', () => {
    console.log('transport ended')
  })
};

const createRecvTransport = async () => {
  await socket.emit('createWebRtcTransport', {sender: false}, ({params}) => {
    console.log(params);

    if (params.error) {
      console.log(params.error);
      return;
    }

    consumerTransport = device.createRecvTransport(params);

    consumerTransport.on('connect', async ({dtlsParameters}, callback, errback) => {
      try {
        await socket.emit('transport-recv-connect', {
          transportId: consumerTransport.id,
          dtlsParameters
        })

        callback();
      }
      catch(err) {
        errback(err);
      }
    });

  })
}

const connectRecvTransport = async () => {
  await socket.emit('consume', {rtpCapabilities: device.rtpCapabilities}, async ({params}) => {
    if (params.error) {
      console.log('Cannot Consume')
      return
    }

    console.log(params)
    consumer = await consumerTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters
    })

    const {track} = consumer;

    const remoteVideo = document.getElementById('remoteVideo');
    remoteVideo.srcObject = new MediaStream([track]);

    socket.emit('consumer-resume');
  })
};

const btnLocalVideo = document.getElementById("btnLocalVideo");
btnLocalVideo.addEventListener("click", getLocalStream);

const btnRtpCapabilities = document.getElementById("btnRtpCapabilities");
btnRtpCapabilities.addEventListener("click", getRtpCapabilities);

const btnCreateDevice = document.getElementById("btnDevice");
btnCreateDevice.addEventListener("click", createDevice);

const btnCreateSendTransport = document.getElementById(
  "btnCreateSendTransport"
);
btnCreateSendTransport.addEventListener("click", createSendTransport);

const btnConnectSendTransport = document.getElementById(
  "btnConnectSendTransport"
);
btnConnectSendTransport.addEventListener("click", connectSendTransport);

const btnSendRecvTransport = document.getElementById('btnRecvSendTransport');
btnSendRecvTransport.addEventListener('click', createRecvTransport);

const btnConnectRecvTransport = document.getElementById('btnConnectRecvTransport');
btnConnectRecvTransport.addEventListener('click', connectRecvTransport);
