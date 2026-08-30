# JOY Shared Profile Schema v3

JOY uses one shared capability model across Android and the web/PWA.

Supported capability categories include:
- vibration / motor zones
- patterns / custom modulation
- rotation
- thrust / linear movement
- suction / air pulse
- heat
- lighting
- battery / charging
- sensors / device events
- music sync / live sound sync
- remote-control eligibility

Safety rule: an unknown writable BLE characteristic is not automatically considered safe.
Unknown hardware remains control-locked until a validated profile maps the required service,
characteristic, command format, and operating range.
