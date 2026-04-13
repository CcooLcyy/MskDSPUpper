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

    fn from_proto(export: FullConfigExport) -> Result<Self, String> {
        if export.schema_version == 0 {
            return Err("Invalid config export: schema_version must be greater than 0".to_string());
        }

        Ok(Self {
            schema_version: export.schema_version,
            exported_at: export.exported_at,
            source: export
                .source
                .map(ExportSourceDto::from_proto)
                .unwrap_or_else(|| ExportSourceDto {
                    manager_addr: String::new(),
                    app_version: None,
                }),
            module_startup: ModuleStartupDto::from_proto(export.module_startup)?,
            config: FullConfigExportConfigDto::from_proto(export.config, export.data_bus)?,
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

    fn from_proto(source: SourceInfo) -> Self {
        Self {
            manager_addr: source.manager_addr,
            app_version: source.app_version,
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

    fn from_proto(startup: Option<ModuleStartup>) -> Result<Self, String> {
        let Some(startup) = startup else {
            return Ok(Self {
                source: String::new(),
                modules: Vec::new(),
            });
        };

        let source = match startup.source {
            MODULE_STARTUP_SOURCE_RUNNING_MODULE_INFO => "get_running_module_info".to_string(),
            0 => String::new(),
            other => {
                return Err(format!(
                    "Unsupported module_startup.source value in config export: {other}"
                ))
            }
        };

        Ok(Self {
            source,
            modules: startup.modules,
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

    fn from_proto(
        config: Option<Config>,
        data_bus: Option<ExportDataBusConfig>,
    ) -> Result<Self, String> {
        let config = config.unwrap_or(Config {
            iec104: None,
            modbus_rtu: None,
            dlt645: None,
            agc: None,
        });

        Ok(Self {
            iec104: Iec104ExportConfigDto::from_proto(config.iec104)?,
            modbus_rtu: ModbusRtuExportConfigDto::from_proto(config.modbus_rtu)?,
            dlt645: Dlt645ExportConfigDto::from_proto(config.dlt645)?,
            agc: AgcExportConfigDto::from_proto(config.agc)?,
            data_bus: DataBusExportConfigDto::from_proto(data_bus)?,
        })
    }
}

impl Iec104ExportConfigDto {
    fn to_proto(&self) -> Iec104Config {
        Iec104Config {
            links: self.links.iter().map(|task| task.to_proto()).collect(),
        }
    }

    fn from_proto(config: Option<Iec104Config>) -> Result<Self, String> {
        let Some(config) = config else {
            return Ok(Self { links: Vec::new() });
        };

        Ok(Self {
            links: config
                .links
                .into_iter()
                .enumerate()
                .map(|(index, task)| Iec104ExportTaskDto::from_proto(index, task))
                .collect::<Result<Vec<_>, _>>()?,
        })
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

    fn from_proto(index: usize, task: Iec104LinkTask) -> Result<Self, String> {
        let link = task
            .link
            .ok_or_else(|| format!("IEC104 export task #{index} is missing link"))?;
        let config = link
            .config
            .ok_or_else(|| format!("IEC104 export task #{index} is missing link.config"))?;
        let fallback_conn_name = config.conn_name.clone();

        let point_table = match task.point_table {
            Some(point_table) => Iec104PointTableRequestDto {
                conn_name: if point_table.conn_name.is_empty() {
                    fallback_conn_name
                } else {
                    point_table.conn_name
                },
                points: point_table.points.into_iter().map(Into::into).collect(),
                replace: point_table.replace,
            },
            None => Iec104PointTableRequestDto {
                conn_name: fallback_conn_name,
                points: Vec::new(),
                replace: false,
            },
        };

        Ok(Self {
            link: Iec104LinkRequestDto {
                config: config.into(),
            },
            point_table,
        })
    }
}

impl ModbusRtuExportConfigDto {
    fn to_proto(&self) -> ModbusRtuConfig {
        ModbusRtuConfig {
            links: self.links.iter().map(|task| task.to_proto()).collect(),
            mqtt: self.mqtt.as_ref().map(|mqtt| mqtt.to_proto()),
        }
    }

    fn from_proto(config: Option<ModbusRtuConfig>) -> Result<Self, String> {
        let Some(config) = config else {
            return Ok(Self {
                mqtt: None,
                links: Vec::new(),
            });
        };

        Ok(Self {
            mqtt: config.mqtt.map(Into::into),
            links: config
                .links
                .into_iter()
                .enumerate()
                .map(|(index, task)| ModbusRtuExportTaskDto::from_proto(index, task))
                .collect::<Result<Vec<_>, _>>()?,
        })
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

    fn from_proto(index: usize, task: ModbusRtuLinkTask) -> Result<Self, String> {
        let link = task
            .link
            .ok_or_else(|| format!("Modbus RTU export task #{index} is missing link"))?;
        let config = link
            .config
            .ok_or_else(|| format!("Modbus RTU export task #{index} is missing link.config"))?;
        let fallback_conn_name = config.conn_name.clone();

        let point_table = match task.point_table {
            Some(point_table) => ModbusRtuPointTableRequestDto {
                conn_name: if point_table.conn_name.is_empty() {
                    fallback_conn_name
                } else {
                    point_table.conn_name
                },
                points: point_table.points.into_iter().map(Into::into).collect(),
                replace: point_table.replace,
            },
            None => ModbusRtuPointTableRequestDto {
                conn_name: fallback_conn_name,
                points: Vec::new(),
                replace: false,
            },
        };

        Ok(Self {
            link: ModbusRtuLinkRequestDto {
                config: config.into(),
            },
            point_table,
        })
    }
}

impl Dlt645ExportConfigDto {
    fn to_proto(&self) -> Dlt645Config {
        Dlt645Config {
            mqtt: self.mqtt.as_ref().map(|mqtt| mqtt.to_proto()),
            links: self.links.iter().map(|task| task.to_proto()).collect(),
        }
    }

    fn from_proto(config: Option<Dlt645Config>) -> Result<Self, String> {
        let Some(config) = config else {
            return Ok(Self {
                mqtt: None,
                links: Vec::new(),
            });
        };

        Ok(Self {
            mqtt: config.mqtt.map(Into::into),
            links: config
                .links
                .into_iter()
                .enumerate()
                .map(|(index, task)| Dlt645ExportTaskDto::from_proto(index, task))
                .collect::<Result<Vec<_>, _>>()?,
        })
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

    fn from_proto(index: usize, task: Dlt645LinkTask) -> Result<Self, String> {
        if !task.device_nos.is_empty() {
            return Err(format!(
                "DLT645 export task #{index} uses device_nos expansion, which is not supported by the current import DTO"
            ));
        }

        let link = task
            .link
            .ok_or_else(|| format!("DLT645 export task #{index} is missing link"))?;
        let config = link
            .config
            .ok_or_else(|| format!("DLT645 export task #{index} is missing link.config"))?;
        let fallback_conn_name = config.conn_name.clone();

        let point_table = match task.point_table {
            Some(point_table) => Dlt645PointTableRequestDto {
                conn_name: if point_table.conn_name.is_empty() {
                    fallback_conn_name
                } else {
                    point_table.conn_name
                },
                points: point_table.points.into_iter().map(Into::into).collect(),
                blocks: point_table.blocks.into_iter().map(Into::into).collect(),
                replace: point_table.replace,
            },
            None => Dlt645PointTableRequestDto {
                conn_name: fallback_conn_name,
                points: Vec::new(),
                blocks: Vec::new(),
                replace: false,
            },
        };

        Ok(Self {
            link: Dlt645LinkRequestDto {
                config: config.into(),
            },
            point_table,
        })
    }
}

impl AgcExportConfigDto {
    fn to_proto(&self) -> AgcConfig {
        AgcConfig {
            groups: self.groups.iter().map(|task| task.to_proto()).collect(),
        }
    }

    fn from_proto(config: Option<AgcConfig>) -> Result<Self, String> {
        let Some(config) = config else {
            return Ok(Self { groups: Vec::new() });
        };

        Ok(Self {
            groups: config
                .groups
                .into_iter()
                .enumerate()
                .map(|(index, task)| AgcExportTaskDto::from_proto(index, task))
                .collect::<Result<Vec<_>, _>>()?,
        })
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

    fn from_proto(index: usize, task: AgcGroupTask) -> Result<Self, String> {
        let upsert = task
            .upsert
            .ok_or_else(|| format!("AGC export group #{index} is missing upsert"))?;
        let config = upsert
            .config
            .ok_or_else(|| format!("AGC export group #{index} is missing upsert.config"))?;

        Ok(Self {
            upsert: AgcUpsertRequestDto {
                config: config.into(),
            },
        })
    }
}

impl DataBusExportConfigDto {
    fn to_proto(&self) -> ExportDataBusConfig {
        ExportDataBusConfig {
            routes: Some(self.routes.to_proto()),
        }
    }

    fn from_proto(data_bus: Option<ExportDataBusConfig>) -> Result<Self, String> {
        Ok(Self {
            routes: DataBusRoutesDto::from_proto(data_bus.and_then(|config| config.routes))?,
        })
    }
}

impl DataBusRoutesDto {
    fn to_proto(&self) -> DataCenterRoutes {
        DataCenterRoutes {
            routes: self.items.iter().map(|route| route.to_proto()).collect(),
            replace: self.replace,
        }
    }

    fn from_proto(routes: Option<DataCenterRoutes>) -> Result<Self, String> {
        let Some(routes) = routes else {
            return Ok(Self {
                replace: false,
                items: Vec::new(),
            });
        };

        Ok(Self {
            replace: routes.replace,
            items: routes
                .routes
                .into_iter()
                .enumerate()
                .map(|(index, route)| StableDataBusRouteDto::from_proto(index, route))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
}

impl StableDataBusRouteDto {
    fn to_proto(&self) -> DataCenterRoute {
        DataCenterRoute {
            src: Some(self.src.to_proto()),
            dst: Some(self.dst.to_proto()),
        }
    }

    fn from_proto(index: usize, route: DataCenterRoute) -> Result<Self, String> {
        let src = route
            .src
            .ok_or_else(|| format!("Data bus route #{index} is missing src"))?;
        let dst = route
            .dst
            .ok_or_else(|| format!("Data bus route #{index} is missing dst"))?;

        Ok(Self {
            src: StableDataBusEndpointDto::from_proto(src),
            dst: StableDataBusEndpointDto::from_proto(dst),
        })
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

    fn from_proto(endpoint: DataCenterEndpoint) -> Self {
        Self {
            module_name: endpoint.module_name,
            conn_name: endpoint.conn_name,
            tag: endpoint.tag,
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

fn ensure_import_path(file_path: &str) -> Result<PathBuf, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err("Import path cannot be empty".to_string());
    }

    Ok(PathBuf::from(trimmed))
}

fn write_export_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
    }

    fs::write(path, bytes).map_err(|err| err.to_string())
}

fn decode_full_config_export(bytes: &[u8]) -> Result<FullConfigExportSnapshotDto, String> {
    let export = FullConfigExport::decode(bytes).map_err(|err| {
        format!("Failed to decode .mskcfg file as FullConfigExport protobuf: {err}")
    })?;

    FullConfigExportSnapshotDto::from_proto(export)
}

fn read_full_config_export_snapshot(path: &Path) -> Result<FullConfigExportSnapshotDto, String> {
    let bytes = fs::read(path).map_err(|err| {
        format!(
            "Failed to read config export file '{}': {err}",
            path.display()
        )
    })?;
    decode_full_config_export(&bytes)
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

#[tauri::command]
pub async fn load_full_config_export(
    file_path: String,
) -> Result<FullConfigExportSnapshotDto, String> {
    let import_path = ensure_import_path(&file_path)?;
    read_full_config_export_snapshot(&import_path)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

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
    fn ensure_import_path_rejects_empty_value() {
        let err = super::ensure_import_path("   ").unwrap_err();
        assert_eq!(err, "Import path cannot be empty");
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

        let decoded_snapshot = super::decode_full_config_export(bytes.as_slice()).unwrap();
        assert_eq!(decoded_snapshot.schema_version, 1);
        assert_eq!(decoded_snapshot.exported_at, "2026-04-10T10:00:00Z");
        assert_eq!(decoded_snapshot.source.manager_addr, "127.0.0.1:17000");
        assert_eq!(decoded_snapshot.module_startup.modules.len(), 2);
        assert!(decoded_snapshot.config.data_bus.routes.replace);
    }

    #[test]
    fn unknown_module_startup_source_is_rejected() {
        let startup = ModuleStartupDto {
            source: "manual".to_string(),
            modules: Vec::new(),
        };

        assert!(startup.to_proto().is_err());
    }

    #[test]
    fn zero_schema_version_is_rejected_on_import() {
        let err = FullConfigExportSnapshotDto::from_proto(
            crate::proto::export_config_proto::FullConfigExport {
                schema_version: 0,
                exported_at: String::new(),
                source: None,
                module_startup: None,
                config: None,
                data_bus: None,
            },
        )
        .unwrap_err();

        assert_eq!(
            err,
            "Invalid config export: schema_version must be greater than 0"
        );
    }

    #[test]
    fn prost_decode_errors_are_wrapped_with_clear_message() {
        let err = super::decode_full_config_export(&[0xFF]).unwrap_err();
        assert!(err.contains("Failed to decode .mskcfg file as FullConfigExport protobuf"));
    }

    #[test]
    fn read_full_config_export_snapshot_reads_file_contents() {
        let snapshot = FullConfigExportSnapshotDto {
            schema_version: 1,
            exported_at: "2026-04-10T10:00:00Z".to_string(),
            source: ExportSourceDto {
                manager_addr: "127.0.0.1:17000".to_string(),
                app_version: Some("0.1.0".to_string()),
            },
            module_startup: ModuleStartupDto {
                source: "get_running_module_info".to_string(),
                modules: vec!["AGC".to_string()],
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
                        replace: false,
                        items: Vec::new(),
                    },
                },
            },
        };
        let export = snapshot.to_proto().unwrap();
        let mut bytes = Vec::new();
        export.encode(&mut bytes).unwrap();

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mskdsp-upper-import-{unique}.mskcfg"));
        fs::write(&path, bytes).unwrap();

        let loaded = super::read_full_config_export_snapshot(&path).unwrap();
        assert_eq!(loaded.schema_version, 1);
        assert_eq!(loaded.module_startup.modules, vec!["AGC".to_string()]);

        fs::remove_file(path).unwrap();
    }
}
