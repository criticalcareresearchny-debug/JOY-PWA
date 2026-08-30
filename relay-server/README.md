# JOY Web-Compatible Relay

Same session/event API used by the Android client, with configurable CORS for the JOY PWA.

Set `JOY_WEB_ORIGINS` to the exact HTTPS origins allowed to call the relay.
For a pilot it can be `*`, but production should specify the JOY web origin(s).

The relay remains payload-blind: clients AES-GCM encrypt text, remote-control commands,
and WebRTC signaling before POSTing them.
