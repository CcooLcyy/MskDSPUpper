use std::{
    fs,
    path::{Path, PathBuf},
};

use prost::Message;
use serde::{Deserialize, Serialize};

use crate::{
    commands::{
        agc::GroupConfigDto,
        dlt645::{Dlt645BlockDto, Dlt645LinkConfigDto, Dlt645MqttConfigDto, Dlt645PointDto},
        iec104::{LinkConfigDto as Iec104LinkConfigDto, PointDto as Iec104PointDto},
        modbus_rtu::{ModbusLinkConfigDto, ModbusMqttConfigDto, ModbusPointDto},
    },
    proto::{
        config_pusher_proto::{
            AgcConfig, AgcGroupTask, Config, DataCenterEndpoint, DataCenterRoute, DataCenterRoutes,
            Dlt645Config, Dlt645LinkTask, Iec104Config, Iec104LinkTask, ModbusRtuConfig,
            ModbusRtuLinkTask,
        },
        export_config_proto::{
            DataBusConfig as ExportDataBusConfig, FullConfigExport, ModuleStartup, SourceInfo,
        },
    },
};

const EXPORT_EXTENSION: &str = "mskcfg";
const MODULE_STARTUP_SOURCE_RUNNING_MODULE_INFO: i32 = 1;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FullConfigExportSnapshotDto {
    pub schema_version: u32,
    pub exported_at: String,
    pub source: ExportSourceDto,
    pub module_startup: ModuleStartupDto,
    pub config: FullConfigExportConfigDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportSourceDto {
    pub manager_addr: String,
    pub app_version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModuleStartupDto {
    pub source: String,
    pub modules: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FullConfigExportConfigDto {
    pub iec104: Iec104ExportConfigDto,
    pub modbus_rtu: ModbusRtuExportConfigDto,
    pub dlt645: Dlt645ExportConfigDto,
    pub agc: AgcExportConfigDto,
    pub data_bus: DataBusExportConfigDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Iec104ExportConfigDto {
    pub links: Vec<Iec104ExportTaskDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Iec104ExportTaskDto {
    pub link: Iec104LinkRequestDto,
    pub point_table: Iec104PointTableRequestDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Iec104LinkRequestDto {
    pub config: Iec104LinkConfigDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Iec104PointTableRequestDto {
    pub conn_name: String,
    pub points: Vec<Iec104PointDto>,
    pub replace: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusRtuExportConfigDto {
    pub mqtt: Option<ModbusMqttConfigDto>,
    pub links: Vec<ModbusRtuExportTaskDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusRtuExportTaskDto {
    pub link: ModbusRtuLinkRequestDto,
    pub point_table: ModbusRtuPointTableRequestDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusRtuLinkRequestDto {
    pub config: ModbusLinkConfigDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModbusRtuPointTableRequestDto {
    pub conn_name: String,
    pub points: Vec<ModbusPointDto>,
    pub replace: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645ExportConfigDto {
    pub mqtt: Option<Dlt645MqttConfigDto>,
    pub links: Vec<Dlt645ExportTaskDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645ExportTaskDto {
    pub link: Dlt645LinkRequestDto,
    pub point_table: Dlt645PointTableRequestDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645LinkRequestDto {
    pub config: Dlt645LinkConfigDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Dlt645PointTableRequestDto {
    pub conn_name: String,
    pub points: Vec<Dlt645PointDto>,
    pub blocks: Vec<Dlt645BlockDto>,
    pub replace: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgcExportConfigDto {
    pub groups: Vec<AgcExportTaskDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgcExportTaskDto {
    pub upsert: AgcUpsertRequestDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgcUpsertRequestDto {
    pub config: GroupConfigDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DataBusExportConfigDto {
    pub routes: DataBusRoutesDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DataBusRoutesDto {
    pub replace: bool,
    pub items: Vec<StableDataBusRouteDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StableDataBusRouteDto {
    pub src: StableDataBusEndpointDto,
    pub dst: StableDataBusEndpointDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StableDataBusEndpointDto {
    pub module_name: String,
    pub conn_name: String,
    pub tag: String,
}

impl FullConfigExportSnapshotDto {
    fn to_proto(&self) -> Result<FullConfigExport, String> {
        Ok(FullConfigExport {
            schema_version: self.schema_version,
            exported_at: self.exported_at.clone(),
            source: Some(self.source.to_proto()),
            module_startup: Some(self.module_startup.to_proto()?),
            config: Some(self.config.to_proto()),
            data_bus: Some(self.config.data_bus.to_proto()),
        })
    }
}

impl ExportSourceDto {
    fn to_proto(&self) -> SourceInfo {
        SourceInfo {
            manager_addr: self.manager_addr.clone(),
            app_version: self.app_version.clone(),
        }
    }
}

impl ModuleStartupDto {
    fn to_proto(&self) -> Result<ModuleStartup, String> {
        let source = match self.source.as_str() {
            "get_running_module_info" => MODULE_STARTUP_SOURCE_RUNNING_MODULE_INFO,
            other => {
                return Err(format!(
                    "Unsupported module_startup.source value for export: {other}"
                ))
            }
        };

        Ok(ModuleStartup {
            source,
            modules: self.modules.clone(),
        })
    }
}

impl FullConfigExportConfigDto {
    fn to_proto(&self) -> Config {
        Config {
            iec104: Some(self.iec104.to_proto()),
            modbus_rtu: Some(self.modbus_rtu.to_proto()),
            dlt645: Some(self.dlt645.to_proto()),
            agc: Some(self.agc.to_proto()),
        }
    }
}

impl Iec104ExportConfigDto {
    fn to_proto(&self) -> Iec104Config {
        Iec104Config {
            links: self.links.iter().map(|task| task.to_proto()).collect(),
        }
    }
}

impl Iec104ExportTaskDto {
    fn to_proto(&self) -> Iec104LinkTask {
        Iec104LinkTask {
            link: Some(crate::proto::iec104_proto::UpsertLinkRequest {
                config: Some(self.link.config.to_proto()),
                create_only: false,
            }),
            point_table: Some(crate::proto::iec104_proto::UpsertPointTableRequest {
                conn_name: self.point_table.conn_name.clone(),
                points: self
                    .point_table
                    .points
                    .iter()
                    .map(|point| point.to_proto())
                    .collect(),
                replace: self.point_table.replace,
            }),
            start: false,
        }
    }
}

impl ModbusRtuExportConfigDto {
    fn to_proto(&self) -> ModbusRtuConfig {
        ModbusRtuConfig {
            links: self.links.iter().map(|task| task.to_proto()).collect(),
            mqtt: self.mqtt.as_ref().map(|mqtt| mqtt.to_proto()),
        }
    }
}

impl ModbusRtuExportTaskDto {
    fn to_proto(&self) -> ModbusRtuLinkTask {
        ModbusRtuLinkTask {
            link: Some(crate::proto::modbus_rtu_proto::UpsertLinkRequest {
                config: Some(self.link.config.to_proto()),
                create_only: false,
            }),
            point_table: Some(crate::proto::modbus_rtu_proto::UpsertPointTableRequest {
                conn_name: self.point_table.conn_name.clone(),
                points: self
                    .point_table
                    .points
                    .iter()
                    .map(|point| point.to_proto())
                    .collect(),
                replace: self.point_table.replace,
            }),
            start: false,
        }
    }
}

impl Dlt645ExportConfigDto {
    fn to_proto(&self) -> Dlt645Config {
        Dlt645Config {
            mqtt: self.mqtt.as_ref().map(|mqtt| mqtt.to_proto()),
            links: self.links.iter().map(|task| task.to_proto()).collect(),
        }
    }
}

impl Dlt645ExportTaskDto {
    fn to_proto(&self) -> Dlt645LinkTask {
        Dlt645LinkTask {
            link: Some(crate::proto::dlt645_proto::UpsertLinkRequest {
                config: Some(self.link.config.to_proto()),
                create_only: false,
            }),
            point_table: Some(crate::proto::dlt645_proto::UpsertPointTableRequest {
                conn_name: self.point_table.conn_name.clone(),
                points: self
                    .point_table
                    .points
                    .iter()
                    .map(|point| point.to_proto())
                    .collect(),
                replace: self.point_table.replace,
                blocks: self
                    .point_table
                    .blocks
                    .iter()
                    .map(|block| block.to_proto())
                    .collect(),
            }),
            start: false,
            device_nos: Vec::new(),
        }
    }
}

impl AgcExportConfigDto {
    fn to_proto(&self) -> AgcConfig {
        AgcConfig {
            groups: self.groups.iter().map(|task| task.to_proto()).collect(),
        }
    }
}

impl AgcExportTaskDto {
    fn to_proto(&self) -> AgcGroupTask {
        AgcGroupTask {
            upsert: Some(crate::proto::agc_proto::UpsertGroupRequest {
                config: Some(self.upsert.config.to_proto()),
                create_only: false,
            }),
            start: false,
        }
    }
}

impl DataBusExportConfigDto {
    fn to_proto(&self) -> ExportDataBusConfig {
        ExportDataBusConfig {
            routes: Some(self.routes.to_proto()),
        }
    }
}

impl DataBusRoutesDto {
    fn to_proto(&self) -> DataCenterRoutes {
        DataCenterRoutes {
            routes: self.items.iter().map(|route| route.to_proto()).collect(),
            replace: self.replace,
        }
    }
}

impl StableDataBusRouteDto {
    fn to_proto(&self) -> DataCenterRoute {
        DataCenterRoute {
            src: Some(self.src.to_proto()),
            dst: Some(self.dst.to_proto()),
        }
    }
}

impl StableDataBusEndpointDto {
    fn to_proto(&self) -> DataCenterEndpoint {
        DataCenterEndpoint {
            module_name: self.module_name.clone(),
            conn_name: self.conn_name.clone(),
            tag: self.tag.clone(),
        }
    }
}

fn ensure_export_path(file_path: &str) -> Result<PathBuf, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("Export path cannot be empty".to_string());
    }

    let mut path = PathBuf::from(trimmed);
    if path.extension().is_none() {
        path.set_extension(EXPORT_EXTENSION);
    }

    Ok(path)
}

fn write_export_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
    }

    fs::write(path, bytes).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_full_config_export(
    file_path: String,
    snapshot: FullConfigExportSnapshotDto,
) -> Result<String, String> {
    let export = snapshot.to_proto()?;
    let final_path = ensure_export_path(&file_path)?;

    let mut bytes = Vec::with_capacity(export.encoded_len());
    export.encode(&mut bytes).map_err(|err| err.to_string())?;
    write_export_file(&final_path, &bytes)?;

    Ok(final_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::{
        AgcExportConfigDto, DataBusExportConfigDto, DataBusRoutesDto, Dlt645ExportConfigDto,
        ExportSourceDto, FullConfigExportConfigDto, FullConfigExportSnapshotDto,
        Iec104ExportConfigDto, ModbusRtuExportConfigDto, ModuleStartupDto,
    };

    #[test]
    fn ensure_export_path_appends_default_extension() {
        let path = super::ensure_export_path("C:\\temp\\demo-export").unwrap();
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("mskcfg")
        );
    }

    #[test]
    fn snapshot_round_trips_through_protobuf() {
        let snapshot = FullConfigExportSnapshotDto {
            schema_version: 1,
            exported_at: "2026-04-10T10:00:00Z".to_string(),
            source: ExportSourceDto {
                manager_addr: "127.0.0.1:17000".to_string(),
                app_version: Some("0.1.0".to_string()),
            },
            module_startup: ModuleStartupDto {
                source: "get_running_module_info".to_string(),
                modules: vec!["AGC".to_string(), "DataCenter".to_string()],
            },
            config: FullConfigExportConfigDto {
                iec104: Iec104ExportConfigDto { links: Vec::new() },
                modbus_rtu: ModbusRtuExportConfigDto {
                    mqtt: None,
                    links: Vec::new(),
                },
                dlt645: Dlt645ExportConfigDto {
                    mqtt: None,
                    links: Vec::new(),
                },
                agc: AgcExportConfigDto { groups: Vec::new() },
                data_bus: DataBusExportConfigDto {
                    routes: DataBusRoutesDto {
                        replace: true,
                        items: Vec::new(),
                    },
                },
            },
        };

        let export = snapshot.to_proto().unwrap();
        let mut bytes = Vec::new();
        export.encode(&mut bytes).unwrap();

        let decoded =
            crate::proto::export_config_proto::FullConfigExport::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.exported_at, "2026-04-10T10:00:00Z");
        assert_eq!(decoded.source.unwrap().manager_addr, "127.0.0.1:17000");
        assert_eq!(decoded.module_startup.unwrap().modules.len(), 2);
        assert!(decoded.data_bus.unwrap().routes.unwrap().replace);
    }

    #[test]
    fn unknown_module_startup_source_is_rejected() {
        let startup = ModuleStartupDto {
            source: "manual".to_string(),
            modules: Vec::new(),
        };

        assert!(startup.to_proto().is_err());
    }
}
