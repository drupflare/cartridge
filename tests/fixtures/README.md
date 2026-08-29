# Test Fixtures

## Java

`java.wasm` is a compiled Java program, used as real input by the interpreters lane. It is the one
fixture here that is build output rather than source, because Java is the one language in
[ADVANCED_USAGE.md](../../ADVANCED_USAGE.md) whose wasm does not ship inside an npm package: the
`@gmitch215/bytebox` install is the loader, and the program is the consumer's.

| File                     | What it is                                                        |
| ------------------------ | ----------------------------------------------------------------- |
| `Cartridge.java`         | the source, printing its argv and whatever the script path holds  |
| `java.wasm`              | that source compiled through TeaVM's WasmGC backend, 19,698 bytes |
| `java.wasm-runtime.js`   | TeaVM's generated runtime, emitted beside the module              |
| `java.wasm-runtime.d.ts` | the one member bytebox drives, declared for `tsc`                 |

The runtime carries no per-module content, so one copy would serve any number of compiled programs.
It is TeaVM output, redistributed here under Apache-2.0.

Two repository rules exist for these two files and both are load-bearing:

- **`*.wasm binary` in `.gitattributes`.** The repo sets `* text eol=lf`, which normalises line
  endings on every matched file. A wasm module carrying a `0x0D 0x0A` pair would lose a byte
  silently. This build has none, which is luck rather than a property of the format.
- **`tests/fixtures/*.wasm-runtime.js` in `.prettierignore`.** The runtime is minified emission.
  Formatting it changes 16,425 bytes into 22,306 and destroys the byte-identity a rebuild is diffed
  against, which is the only way to notice the fixture has drifted from its source.

### Rebuilding

Compiled with TeaVM 0.15.0 against a JDK 21 toolchain, the same settings
[bytebox](https://github.com/gmitch215/bytebox) uses for its own fixtures:

```kotlin
teavm {
	all { mainClass = "fixture.Cartridge" }
	wasmGC {
		modularRuntime = true
		minDirectBuffersSize = 1
		obfuscated = true
		debugInformation = false
		sourceMap = false
		optimization = OptimizationLevel.AGGRESSIVE
	}
}
```

`Cartridge.java` needs `org.teavm:teavm-jso:0.15.0` on the compile classpath for `@JSBody`. The build is
reproducible: the same source and settings emit a byte-identical module and runtime.

## Others

`do-host.ts` is a Durable Object host for the gate lane, not build output.
