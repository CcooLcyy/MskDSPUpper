use super::lower_update::{parse_upload_account, LowerUpdateRemoteTargetDto};
use crate::{
    grpc::connection::ConnectionManager, grpc::module_manager::ModuleManagerClient, state::AppState,
};
use serde::Deserialize;
use std::time::Duration;
use tauri::State;

#[derive(Deserialize)]
pub struct LowerUpdateReconnectRequestDto {
    pub upload_account: String,
    pub remote_target: Option<LowerUpdateRemoteTargetDto>,
}

fn matches_update_target(
    connection: &ConnectionManager,
    request: &LowerUpdateReconnectRequestDto,
) -> Result<bool, String> {
    match (&request.remote_target, connection.remote_connection()) {
        (Some(target), Some(remote)) => {
            Ok(target.endpoint == remote.endpoint && target.device_id == remote.device.device_id)
        }
        (None, None) => {
            let target = parse_upload_account(&request.upload_account)?;
            Ok(target.host.eq_ignore_ascii_case(&connection.manager_host()))
        }
        _ => Ok(false),
    }
}

async fn reconnect_runtime(
    connection: &ConnectionManager,
    request: LowerUpdateReconnectRequestDto,
) -> Result<bool, String> {
    let snapshot = connection.runtime_refresh_snapshot();
    if !matches_update_target(&snapshot.connection, &request)? {
        return Ok(false);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let refreshed = tokio::time::timeout_at(deadline, async {
        let client = ModuleManagerClient::new(&snapshot.connection);
        client.get_module_info().await?;
        client.get_running_module_info().await?;
        Ok::<(), anyhow::Error>(())
    })
    .await;
    if !connection.runtime_refresh_is_current(&snapshot) {
        return Ok(false);
    }
    match refreshed {
        Ok(Ok(())) => {
            match tokio::time::timeout_at(deadline, connection.publish_runtime_refresh(&snapshot))
                .await
            {
                Ok(published) => Ok(published),
                Err(_) if !connection.runtime_refresh_is_current(&snapshot) => Ok(false),
                Err(_) => Err("自动刷新下位机连接超时".into()),
            }
        }
        Ok(Err(error)) => Err(format!("自动刷新下位机连接失败：{error}")),
        Err(_) => Err("自动刷新下位机连接超时".into()),
    }
}

/// 只刷新仍被选中的更新目标，不切换设备、平台登录或 SSH 会话。
#[tauri::command]
pub async fn reconnect_lower_update_runtime(
    state: State<'_, AppState>,
    request: LowerUpdateReconnectRequestDto,
) -> Result<bool, String> {
    let target = request
        .remote_target
        .as_ref()
        .map(|remote| format!("{} / {}", remote.endpoint, remote.device_id))
        .unwrap_or_else(|| request.upload_account.clone());
    tracing::info!(target, "下位机更新完成，开始自动刷新业务连接");
    let result = reconnect_runtime(&state.conn_manager, request).await;
    match &result {
        Ok(true) => tracing::info!(target, "下位机业务连接自动刷新完成"),
        Ok(false) => tracing::info!(target, "当前连接目标已切换，跳过原下位机的自动刷新"),
        Err(error) if error == "自动刷新下位机连接超时" => {
            tracing::warn!(target, "下位机业务连接自动刷新超时，等待重试")
        }
        Err(error) => tracing::warn!(target, %error, "下位机业务连接自动刷新未完成，等待重试"),
    }
    result
}

#[cfg(test)]
#[path = "lower_update_reconnect_tests.rs"]
mod rpc_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        platform_auth::PlatformAuthManager,
        remote_access::{RemoteConnection, RemoteDevice},
    };
    use std::sync::Arc;

    fn request(host: &str) -> LowerUpdateReconnectRequestDto {
        LowerUpdateReconnectRequestDto {
            upload_account: format!("user@{host}:10022"),
            remote_target: None,
        }
    }

    // SSH 更新账号只用于识别设备，不能覆盖当前自定义的 ModuleManager 端口。
    #[test]
    fn direct_matches_host_preserves_manager_port_and_rejects_other_hosts() {
        let manager = ConnectionManager::new("Device:17999".into());
        assert!(matches_update_target(&manager, &request("device")).unwrap());
        assert!(!matches_update_target(&manager, &request("other")).unwrap());
        assert_eq!(
            manager.runtime_refresh_snapshot().connection.manager_addr(),
            "Device:17999"
        );
    }

    // 远程目标须同时匹配平台和设备；复用连接不得取消 SSH，失效会话不得发布成功。
    #[tokio::test]
    async fn remote_requires_same_platform_and_device_and_preserves_session() {
        let manager = ConnectionManager::new("device:17000".into());
        let auth = Arc::new(PlatformAuthManager::test_session(
            "http://platform:50051".into(),
        ));
        let remote = RemoteConnection::new(
            RemoteDevice {
                device_id: "original".into(),
                display_name: "Original".into(),
                online: true,
                allow_grpc: true,
                allow_ssh: true,
                services: vec![],
                agent_version: "test".into(),
            },
            auth,
        )
        .unwrap();
        manager.select_remote(Some(remote.clone())).await;
        let mut target = request("device");
        assert!(!matches_update_target(&manager, &target).unwrap());
        target.remote_target = Some(LowerUpdateRemoteTargetDto {
            endpoint: "http://platform:50051".into(),
            device_id: "original".into(),
        });
        assert!(matches_update_target(&manager, &target).unwrap());
        target.remote_target.as_mut().unwrap().device_id = "other".into();
        assert!(!matches_update_target(&manager, &target).unwrap());
        target.remote_target.as_mut().unwrap().device_id = "original".into();
        target.remote_target.as_mut().unwrap().endpoint = "http://other:50051".into();
        assert!(!matches_update_target(&manager, &target).unwrap());
        let snapshot = manager.runtime_refresh_snapshot();
        assert!(Arc::ptr_eq(
            &snapshot.connection.remote_connection().unwrap(),
            &remote
        ));
        assert!(manager.publish_runtime_refresh(&snapshot).await);
        assert!(remote.active());
        let snapshot = manager.runtime_refresh_snapshot();
        remote.cancel();
        assert!(!manager.runtime_refresh_is_current(&snapshot));
        assert!(!manager.publish_runtime_refresh(&snapshot).await);
    }

    // 更新设备与当前设备不同，应直接跳过，避免对新目标发网络请求或清缓存。
    #[tokio::test]
    async fn mismatched_target_skips_network_and_preserves_addresses() {
        let manager = ConnectionManager::new("127.0.0.1:1".into());
        manager.update_module_addr("IEC104", "127.0.0.1:2");
        assert!(!reconnect_runtime(&manager, request("other")).await.unwrap());
        assert_eq!(
            manager.get_module_addr("IEC104").as_deref(),
            Some("127.0.0.1:2")
        );
    }

    // 服务仍在启动时只报告暂时失败，已有业务地址留待后续重试替换。
    #[tokio::test]
    async fn failed_refresh_keeps_current_runtime_cache() {
        let manager = ConnectionManager::new("127.0.0.1:1".into());
        manager.update_module_addr("IEC104", "127.0.0.1:2");
        let generation = manager.runtime_generation();
        assert!(reconnect_runtime(&manager, request("127.0.0.1"))
            .await
            .is_err());
        assert_eq!(manager.runtime_generation(), generation);
        assert_eq!(
            manager.get_module_addr("IEC104").as_deref(),
            Some("127.0.0.1:2")
        );
    }
}
