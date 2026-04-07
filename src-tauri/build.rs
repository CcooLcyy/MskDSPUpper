use std::env;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Proto files are provided by the repository-local submodule at ../proto.
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"),
    );
    let proto_dir = manifest_dir.join("..").join("proto");

    let marker = proto_dir.join("ModuleManager.proto");
    if !marker.is_file() {
        panic!(
            "Proto directory is missing at {}. Run `git submodule update --init --recursive` from the repository root first.",
            proto_dir.display()
        );
    }

    let protos = [
        proto_dir.join("ModuleManager.proto"),
        proto_dir.join("DataCenter.proto"),
        proto_dir.join("IEC104.proto"),
        proto_dir.join("ModbusRTU.proto"),
        proto_dir.join("DLT645.proto"),
        proto_dir.join("AGC.proto"),
        proto_dir.join("AVC.proto"),
        proto_dir.join("ConfigPusher.proto"),
        proto_dir.join("MQTTManager.proto"),
    ];

    for proto in &protos {
        println!("cargo:rerun-if-changed={}", proto.display());
    }

    tonic_build::configure()
        .build_server(false)
        .build_client(true)
        .out_dir("src/proto_gen")
        .compile_protos(&protos, &[&proto_dir])
        .expect("Failed to compile protobuf files");
}
