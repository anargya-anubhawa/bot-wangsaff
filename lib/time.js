/**
 * GX-ID — time helpers (Asia/Jakarta).
 */
import moment from "moment-timezone";

const TIMEZONE = "Asia/Jakarta";
moment.locale("id");

export function now() {
  return moment.tz(TIMEZONE);
}

export function formatTime(format = "HH:mm:ss") {
  return moment.tz(TIMEZONE).format(format);
}

export function formatFull(format = "dddd, DD MMMM YYYY HH:mm:ss") {
  return moment.tz(TIMEZONE).format(format);
}

export function getHour() {
  return parseInt(moment.tz(TIMEZONE).format("HH"), 10);
}

export function fromTimestamp(timestamp, format = "DD-MM-YYYY HH:mm:ss") {
  return moment(timestamp).tz(TIMEZONE).format(format);
}

export function getTimeGreeting() {
  const hour = getHour();
  if (hour >= 4 && hour < 10) return "Selamat Pagi 🌅";
  if (hour >= 10 && hour < 15) return "Selamat Siang ☀️";
  if (hour >= 15 && hour < 18) return "Selamat Sore 🌇";
  return "Selamat Malam 🌙";
}

export { TIMEZONE };
