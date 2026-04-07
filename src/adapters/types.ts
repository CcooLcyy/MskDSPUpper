export interface ModuleVersion {
  major: string;
  minor: string;
  patch: string;
  version: string;
}

export interface ModuleDependency {
  module_name: string;
  version_range: string;
}

export interface ModuleInfo {
  module_name: string;
  version: ModuleVersion | null;
  lib_name: string;
  dependencies: ModuleDependency[];
  manifest_error: string;
}

export interface ModuleRunningInfo {
  module_name: string;
  version: ModuleVersion | null;
  lib_name: string;
  inner_grpc_server: string;
  outer_grpc_server: string;
}
