# Native resources

The Windows native build workflow downloads the Apache-2.0 MODNet ONNX model into
`resources/models/modnet.onnx` before packaging.

ONNX Runtime/DirectML DLLs produced by the Rust `ort` dependency are copied into
this resource directory by the Windows workflow so the NSIS installer can place
them next to the executable.
