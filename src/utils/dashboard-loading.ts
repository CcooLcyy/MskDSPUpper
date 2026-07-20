export type SettledResult<T> = PromiseSettledResult<T>;

export type DashboardLoadOperations<
  ModuleInfo,
  RunningModuleInfo,
  Iec104Link,
  ModbusLink,
  Dlt645Link,
  AgcGroup,
  Route,
> = {
  getModuleInfo: () => Promise<ModuleInfo[]>;
  getRunningModuleInfo: () => Promise<RunningModuleInfo[]>;
  listIec104Links: () => Promise<Iec104Link[]>;
  listModbusLinks: () => Promise<ModbusLink[]>;
  listDlt645Links: () => Promise<Dlt645Link[]>;
  listAgcGroups: () => Promise<AgcGroup[]>;
  listRoutes: () => Promise<Route[]>;
};

export type DashboardLoadResults<
  ModuleInfo,
  RunningModuleInfo,
  Iec104Link,
  ModbusLink,
  Dlt645Link,
  AgcGroup,
  Route,
> = {
  modules: SettledResult<ModuleInfo[]>;
  runningModules: SettledResult<RunningModuleInfo[]>;
  iec104Links: SettledResult<Iec104Link[]>;
  modbusLinks: SettledResult<ModbusLink[]>;
  dlt645Links: SettledResult<Dlt645Link[]>;
  agcGroups: SettledResult<AgcGroup[]>;
  routes: SettledResult<Route[]>;
};

const skippedResult = (reason: unknown): PromiseRejectedResult => ({
  status: 'rejected',
  reason,
});

export async function loadDashboardAfterRunningModules<
  ModuleInfo,
  RunningModuleInfo,
  Iec104Link,
  ModbusLink,
  Dlt645Link,
  AgcGroup,
  Route,
>(
  operations: DashboardLoadOperations<
    ModuleInfo,
    RunningModuleInfo,
    Iec104Link,
    ModbusLink,
    Dlt645Link,
    AgcGroup,
    Route
  >,
): Promise<DashboardLoadResults<ModuleInfo, RunningModuleInfo, Iec104Link, ModbusLink, Dlt645Link, AgcGroup, Route>> {
  const [runningModules] = await Promise.allSettled([
    operations.getRunningModuleInfo(),
  ]);

  if (runningModules.status === 'rejected') {
    const [modules] = await Promise.allSettled([operations.getModuleInfo()]);
    return {
      modules,
      runningModules,
      iec104Links: skippedResult(runningModules.reason),
      modbusLinks: skippedResult(runningModules.reason),
      dlt645Links: skippedResult(runningModules.reason),
      agcGroups: skippedResult(runningModules.reason),
      routes: skippedResult(runningModules.reason),
    };
  }

  const [modules, iec104Links, modbusLinks, dlt645Links, agcGroups, routes] = await Promise.allSettled([
    operations.getModuleInfo(),
    operations.listIec104Links(),
    operations.listModbusLinks(),
    operations.listDlt645Links(),
    operations.listAgcGroups(),
    operations.listRoutes(),
  ]);

  return {
    modules,
    runningModules,
    iec104Links,
    modbusLinks,
    dlt645Links,
    agcGroups,
    routes,
  };
}
