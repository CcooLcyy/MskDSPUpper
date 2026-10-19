use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // 图标变更必须重新编译 Windows 资源，避免增量构建或 CI 缓存沿用旧图标。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // 主程序与 Rust 测试由 linker 统一生成相同清单，资源库仅保留图标与版本，避免重复清单资源。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("生成上位机构建资源失败");
    // Rust 单元测试也链接原生对话框，声明相同的 Common Controls v6 依赖，避免测试进程入口缺失。
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }

    // Proto files are provided by the repository-local submodule at ../proto.
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    // protoc 的 Windows 路径参数不能可靠处理非 ASCII 仓库路径，使用构建目录相对路径。
    let proto_dir = PathBuf::from("../proto");
    let proto_out_dir = manifest_dir.join("src").join("proto_gen");

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
        proto_dir.join("ModbusTCP.proto"),
        proto_dir.join("DLT645.proto"),
        proto_dir.join("AGC.proto"),
        proto_dir.join("AVC.proto"),
        proto_dir.join("Calc.proto"),
        proto_dir.join("ConfigPusher.proto"),
        proto_dir.join("IEC61850.proto"),
        proto_dir.join("ExportConfig.proto"),
        proto_dir.join("MQTTManager.proto"),
        proto_dir.join("ControlOrchestrator.proto"),
    ];

    for proto in &protos {
        println!("cargo:rerun-if-changed={}", proto.display());
    }

    fs::create_dir_all(&proto_out_dir).expect("Failed to create proto output directory");

    tonic_build::configure()
        .build_server(false)
        .build_client(true)
        .out_dir(&proto_out_dir)
        .compile_protos(&protos, &[&proto_dir])
        .expect("Failed to compile protobuf files");

    // 平台软件协议独立生成到 OUT_DIR，不与设备协议命名或输出目录混用。
    let platform_root = PathBuf::from("../proto-platform");
    let platform_protocol = platform_root.join("platform/v1/software.proto");
    println!("cargo:rerun-if-changed={}", platform_protocol.display());
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(&[platform_protocol], &[platform_root])
        .expect("生成平台软件仓库协议失败");
}
