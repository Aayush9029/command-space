import {LocalStorage, environment, showHUD} from "@raycast/api";

export default async function Command(props) {
  if (!props.launchContext) return;
  const launches = Number(await LocalStorage.getItem("receiverLaunches") || 0) + 1;
  await LocalStorage.setItem("receiverLaunches", launches);
  await LocalStorage.setItem("receiver", {
    arguments:props.arguments, launchType:props.launchType, environmentType:environment.launchType,
    fallbackText:props.fallbackText, date:props.launchContext.date.toISOString(),
    isDate:props.launchContext.date instanceof Date, isBuffer:Buffer.isBuffer(props.launchContext.buffer),
    buffer:props.launchContext.buffer.toString(),
  });
  await showHUD(`Background receiver launch ${launches}`);
}
