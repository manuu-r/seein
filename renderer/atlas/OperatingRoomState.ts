export type OperatingRoomState = {
  visible: boolean;
  ambientLights: boolean;
  surgicalLights: boolean;
  surgicalLightIntensity: number;
  boomPosition: number;
  ventilator: boolean;
  monitor: boolean;
  alarmMuted: boolean;
  trayOpen: boolean;
};

export type OperatingRoomUpdate = Partial<OperatingRoomState>;

export const DEFAULT_OPERATING_ROOM_STATE: OperatingRoomState = {
  visible: true,
  ambientLights: true,
  surgicalLights: true,
  surgicalLightIntensity: 0.78,
  boomPosition: 0.58,
  ventilator: true,
  monitor: true,
  alarmMuted: false,
  trayOpen: true,
};

export function mergeOperatingRoomState(
  state: OperatingRoomState,
  update: OperatingRoomUpdate,
): OperatingRoomState {
  return { ...state, ...update };
}
