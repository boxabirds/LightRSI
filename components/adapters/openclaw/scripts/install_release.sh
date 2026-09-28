#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_OPENCLAW_HOME="${HOME}"
OPENCLAW_HOME="${LIGHTRSI_OPENCLAW_HOME:-${LIGHTMEM2_OPENCLAW_HOME:-${TOKENPILOT_OPENCLAW_HOME:-${DEFAULT_OPENCLAW_HOME}}}}"
export HOME="${OPENCLAW_HOME}"
export XDG_CACHE_HOME="${HOME}/.cache"
export XDG_CONFIG_HOME="${HOME}/.config"
mkdir -p "${XDG_CACHE_HOME}" "${XDG_CONFIG_HOME}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
OPENCLAW_PROFILE="${LIGHTRSI_OPENCLAW_PROFILE:-${LIGHTMEM2_OPENCLAW_PROFILE:-${OPENCLAW_PROFILE:-}}}"
OPENCLAW_STATE_DIR="${LIGHTRSI_OPENCLAW_STATE_DIR:-${LIGHTMEM2_OPENCLAW_STATE_DIR:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}}}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-}"
DEV_PLUGIN_PATH="${PLUGIN_DIR}"
INSTALLED_PLUGIN_PATH="${HOME}/.openclaw/extensions/tokenpilot"

openclaw_cmd() {
  local -a cmd=("openclaw")
  if [[ -n "${OPENCLAW_PROFILE}" ]]; then
    cmd+=("--profile" "${OPENCLAW_PROFILE}")
  fi
  cmd+=("$@")
  env \
    HOME="${HOME}" \
    XDG_CACHE_HOME="${XDG_CACHE_HOME}" \
    XDG_CONFIG_HOME="${XDG_CONFIG_HOME}" \
    OPENCLAW_CONFIG_PATH="${CONFIG_PATH}" \
    OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" \
    ${OPENCLAW_GATEWAY_PORT:+OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT}"} \
    "${cmd[@]}"
}

run_release_config_helper() {
  local operation="$1"
  local post_install="${2:-0}"
  local helper="${SCRIPT_DIR}/configure-release.cjs"
  local node_command=""
  local node_exe_command=""
  local node_exe_base=""

  if [[ ! -f "${helper}" ]]; then
    printf '%s\n' "Release configuration helper not found at ${helper}" >&2
    return 1
  fi

  node_command="$(command -v node 2>/dev/null || true)"
  node_exe_command="$(command -v node.exe 2>/dev/null || true)"
  node_exe_base="${node_exe_command%.exe}"
  if [[ -n "${node_command}" \
    && "${node_command,,}" != *.exe \
    && "${node_command,,}" != "${node_exe_base,,}" ]]; then
    node "${helper}" "${operation}" "${post_install}" \
      "${DEV_PLUGIN_PATH}" "${INSTALLED_PLUGIN_PATH}" \
      "${HOME}/.openclaw/tokenpilot-plugin-state" 1
    return
  fi

  if command -v node.exe >/dev/null 2>&1; then
    local windows_helper="${helper}"
    local windows_dev_plugin_path="${DEV_PLUGIN_PATH}"
    local windows_installed_plugin_path="${INSTALLED_PLUGIN_PATH}"
    local windows_default_state_dir="${HOME}/.openclaw/tokenpilot-plugin-state"
    local check_path_exists=1
    if command -v wslpath >/dev/null 2>&1; then
      windows_helper="$(wslpath -w "${helper}")"
      windows_dev_plugin_path="$(wslpath -w "${DEV_PLUGIN_PATH}")"
      windows_installed_plugin_path="$(wslpath -w "${INSTALLED_PLUGIN_PATH}")"
      windows_default_state_dir="$(wslpath -w "${HOME}/.openclaw/tokenpilot-plugin-state")"
      check_path_exists=0
    elif command -v cygpath >/dev/null 2>&1; then
      windows_helper="$(cygpath -w "${helper}")"
      windows_dev_plugin_path="$(cygpath -w "${DEV_PLUGIN_PATH}")"
      windows_installed_plugin_path="$(cygpath -w "${INSTALLED_PLUGIN_PATH}")"
      windows_default_state_dir="$(cygpath -w "${HOME}/.openclaw/tokenpilot-plugin-state")"
    fi
    env 'MSYS2_ARG_CONV_EXCL=*' node.exe \
      "${windows_helper}" "${operation}" "${post_install}" \
      "${windows_dev_plugin_path}" "${windows_installed_plugin_path}" \
      "${windows_default_state_dir}" "${check_path_exists}" \
      "${DEV_PLUGIN_PATH}" "${INSTALLED_PLUGIN_PATH}"
    return
  fi

  printf '%s\n' "Node.js is required to update the OpenClaw release configuration" >&2
  return 1
}

write_release_config() {
  local operation="$1"
  local post_install="${2:-0}"
  local tmp_file
  tmp_file="$(mktemp)"
  if ! run_release_config_helper "${operation}" "${post_install}" \
    < "${CONFIG_PATH}" > "${tmp_file}"; then
    rm -f "${tmp_file}"
    return 1
  fi
  if cmp -s "${tmp_file}" "${CONFIG_PATH}"; then
    rm -f "${tmp_file}"
    return
  fi
  if [[ "${operation}" == "sanitize" ]]; then
    cp "${CONFIG_PATH}" "${CONFIG_PATH}.bak.release-install"
  fi
  mv "${tmp_file}" "${CONFIG_PATH}"
}

sanitize_plugin_config() {
  local post_install="${1:-0}"
  if [[ ! -f "${CONFIG_PATH}" ]]; then
    return 0
  fi
  write_release_config sanitize "${post_install}"
}

prepare_config_for_install() {
  if [[ ! -f "${CONFIG_PATH}" ]]; then
    return 0
  fi
  write_release_config prepare 0
}
install_bundled_cli() {
  local installer="${INSTALLED_PLUGIN_PATH}/dist/install-cli.js"
  local cli_source="${INSTALLED_PLUGIN_PATH}/dist/lightrsi.js"
  local bin_dir="${LIGHTRSI_BIN_DIR:-${LIGHTMEM2_BIN_DIR:-${HOME}/.local/bin}}"
  if [[ ! -f "${installer}" ]]; then
    printf '%s\n' "Bundled lightrsi CLI installer not found at ${installer}" >&2
    return 1
  fi
  if [[ ! -f "${cli_source}" ]]; then
    printf '%s\n' "Bundled lightrsi CLI not found at ${cli_source}" >&2
    return 1
  fi

  local node_command=""
  local node_exe_command=""
  local node_exe_base=""
  node_command="$(command -v node 2>/dev/null || true)"
  node_exe_command="$(command -v node.exe 2>/dev/null || true)"
  node_exe_base="${node_exe_command%.exe}"
  if [[ -n "${node_command}" \
    && "${node_command,,}" != *.exe \
    && "${node_command,,}" != "${node_exe_base,,}" ]]; then
    node "${installer}"
    return
  fi
  if command -v node.exe >/dev/null 2>&1; then
    # WSL can invoke Windows Node for the bundled CLI, but Windows Node cannot
    # create a command inside the WSL home directory. Install a POSIX wrapper
    # in that shell and translate only the bundled script path for node.exe.
    if command -v wslpath >/dev/null 2>&1; then
      local windows_cli
      local quoted_windows_cli
      windows_cli="$(wslpath -w "${cli_source}")"
      quoted_windows_cli="'${windows_cli//\'/\'\"\'\"\'}'"
      mkdir -p "${bin_dir}"
      printf '#!/bin/sh\nexec node.exe %s "$@"\n' "${quoted_windows_cli}" > "${bin_dir}/lightrsi"
      cp "${bin_dir}/lightrsi" "${bin_dir}/lightmem2"
      chmod +x "${bin_dir}/lightrsi" "${bin_dir}/lightmem2"
      printf 'Installed lightrsi CLI -> %s\n' "${bin_dir}/lightrsi"
      if [[ ":${PATH}:" != *":${bin_dir}:"* ]]; then
        printf 'Add %s to PATH before using lightrsi.\n' "${bin_dir}"
      fi
      return
    fi

    local windows_installer="${installer}"
    local windows_bin_dir="${bin_dir}"
    if command -v cygpath >/dev/null 2>&1; then
      windows_installer="$(cygpath -w "${installer}")"
      windows_bin_dir="$(cygpath -w "${bin_dir}")"
    fi
    LIGHTRSI_BIN_DIR="${windows_bin_dir}" node.exe "${windows_installer}"
    return
  fi
  printf '%s\n' "Node.js is required to install the bundled lightrsi CLI" >&2
  return 1
}

main() {
  sanitize_plugin_config 0

  local archive_path
  archive_path="$("${SCRIPT_DIR}/pack_release.sh")"
  if command -v wslpath >/dev/null 2>&1; then
    case "${archive_path}" in
      [A-Za-z]:[\\/]*) archive_path="$(wslpath -u "${archive_path}")" ;;
    esac
  fi
  prepare_config_for_install
  openclaw_cmd plugins install "${archive_path}" --force --accept-capabilities
  sanitize_plugin_config 1
  install_bundled_cli
  if ! openclaw_cmd gateway restart; then
    printf '%s\n' "Warning: gateway restart failed; restart it manually if needed."
  fi

  printf 'Installed release plugin from %s\n' "${archive_path}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
