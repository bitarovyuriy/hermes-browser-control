# relay/ — loopback relay (vendored)

The relay is what actually connects the extension to your runtime: the extension opens
`ws://127.0.0.1:<port>/browser/extension`, the runtime side connects to
`ws://127.0.0.1:<port>/browser/runtime`, and the relay forwards commands between them
(tickets, redaction and the connection-state machine included).

    cd relay
    npm install            # one dependency: ws
    npm start -- --port 47317 --log ../relay.log

Endpoints: `/browser/extension`, `/browser/runtime`, `/browser/pair` (POST, mints a
single-use `hbrt_*` ticket), `/browser/echo`, `/browser/status`.

This directory is a vendored copy of the relay from the transport project
(`relay/`, `src/transport/{types,logger}.ts`); the extension ships the matching client
under `extension/vendor/transport/`. When the transport project changes, re-copy those
files here and re-run `npm run test:relay`.
