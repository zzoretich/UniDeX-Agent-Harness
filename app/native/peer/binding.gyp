# The peer addon (agent-computer D18): the app's own Node-API addon, built by scripts/build-native.mjs from the app's
# postinstall and shipped unpacked beside node-pty (electron-builder.yml). Plain Node-API, so one build loads in Node
# (the unit tests) and in Electron (the app) alike. macOS 13 is Electron 44's own minimum. Linked with no debug map
# (-Wl,-S), which would carry the build folder's path into the app.
{
  "targets": [
    {
      "target_name": "peer",
      "sources": ["peer.mm"],
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "WARNING_CFLAGS": ["-Wall", "-Wextra"],
        "OTHER_LDFLAGS": ["-Wl,-S"]
      },
      "link_settings": {
        "libraries": ["-framework CoreFoundation", "-framework Security"]
      }
    }
  ]
}
