// The peer addon (agent-computer D18): what Node cannot tell the agent bridge about a connection. Plain Node-API (no
// node-addon-api); src/main/computer/peer.ts loads it and carries its types.
//
//   peerPid(fd)         the pid at the other end of a connected Unix socket (getsockopt LOCAL_PEERPID); throws on
//                       failure
//   procInfo(pid)       { pid, ppid, path, argv } from proc_pidinfo, proc_pidpath and KERN_PROCARGS2; null when the
//                       process is gone or not this user's to read
//   teamId(path)        the Apple team that signed the file at an absolute path, the check before a launch; null when
//                       it is unsigned, ad hoc, invalid or not code
//   processTeamId(pid)  the Apple team that signed the code a running process runs, the check at admission; null when
//                       the process is gone, or its code is unsigned, ad hoc, invalid or no longer the file at its path
//
// Either team counts only when an Apple-issued certificate vouches for it. An argument of the wrong type throws a
// TypeError.

#include <node_api.h>

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <libproc.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/un.h>

#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

// A Node-API failure that left no exception pending becomes one, so a call never returns undefined silently.
bool ok(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, nullptr, "peer: a Node-API call failed");
  return false;
}

napi_value first_arg(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg = nullptr;  // undefined when the call passed nothing
  return ok(env, napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr)) ? arg : nullptr;
}

// The one argument as an integer from `min` to INT32_MAX, or a TypeError.
bool int_arg(napi_env env, napi_callback_info info, const char* fn, const char* name, int min, int* out) {
  napi_value arg = first_arg(env, info);
  napi_valuetype type = napi_undefined;
  if (!arg || !ok(env, napi_typeof(env, arg, &type))) return false;
  double d = 0;
  if (type == napi_number && !ok(env, napi_get_value_double(env, arg, &d))) return false;
  if (type != napi_number || std::trunc(d) != d || d < min || d > INT32_MAX) {  // NaN fails the first test
    std::string msg = std::string(fn) + ": " + name + " must be an integer from " + std::to_string(min) + " to 2147483647";
    napi_throw_type_error(env, nullptr, msg.c_str());
    return false;
  }
  *out = static_cast<int>(d);
  return true;
}

// The one argument as an absolute path with no NUL in it (the C calls would cut it short; a relative one would be
// read against whatever the working directory is), or a TypeError.
bool path_arg(napi_env env, napi_callback_info info, const char* fn, std::string* out) {
  napi_value arg = first_arg(env, info);
  napi_valuetype type = napi_undefined;
  if (!arg || !ok(env, napi_typeof(env, arg, &type))) return false;
  if (type == napi_string) {
    size_t len = 0;
    if (!ok(env, napi_get_value_string_utf8(env, arg, nullptr, 0, &len))) return false;
    out->assign(len + 1, '\0');
    if (!ok(env, napi_get_value_string_utf8(env, arg, out->data(), len + 1, &len))) return false;
    out->resize(len);
    if (!out->empty() && (*out)[0] == '/' && out->find('\0') == std::string::npos) return true;
  }
  std::string msg = std::string(fn) + ": path must be an absolute path without NUL characters";
  napi_throw_type_error(env, nullptr, msg.c_str());
  return false;
}

bool set(napi_env env, napi_value obj, const char* key, napi_value value) {
  return ok(env, napi_set_named_property(env, obj, key, value));
}

// ── peerPid ──────────────────────────────────────────────────────────

napi_value peer_pid(napi_env env, napi_callback_info info) {
  int fd = -1;
  if (!int_arg(env, info, "peerPid", "fd", 0, &fd)) return nullptr;
  pid_t pid = 0;
  socklen_t len = sizeof pid;
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) != 0) {
    int err = errno;
    std::string msg = std::string("peerPid: getsockopt(LOCAL_PEERPID) failed: ") + std::strerror(err);
    napi_throw_error(env, nullptr, msg.c_str());
    return nullptr;
  }
  if (len != sizeof pid) {
    napi_throw_error(env, nullptr, "peerPid: getsockopt(LOCAL_PEERPID) returned no pid");
    return nullptr;
  }
  napi_value out = nullptr;
  return ok(env, napi_create_int32(env, pid, &out)) ? out : nullptr;
}

// ── procInfo ─────────────────────────────────────────────────────────

// The process's argv from KERN_PROCARGS2: an int argc, the executable path, NUL padding, then argc NUL-terminated
// strings (the environment follows). False when the kernel refuses (gone, a zombie, another user's) or the buffer does
// not hold argc whole strings. Like ps(1), the padding walk cannot tell an empty argv[0] from padding.
bool read_argv(int pid, std::vector<std::string>* argv) {
  int argmax = 0;
  size_t size = sizeof argmax;
  int max_mib[2] = {CTL_KERN, KERN_ARGMAX};
  if (sysctl(max_mib, 2, &argmax, &size, nullptr, 0) != 0 || argmax <= 0) return false;
  std::vector<char> buf(static_cast<size_t>(argmax));
  size = buf.size();
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  if (sysctl(mib, 3, buf.data(), &size, nullptr, 0) != 0 || size < sizeof(int) || size > buf.size()) return false;
  int argc = 0;
  std::memcpy(&argc, buf.data(), sizeof argc);
  if (argc < 0) return false;
  const char* p = buf.data() + sizeof argc;
  const char* end = buf.data() + size;
  while (p < end && *p) ++p;   // the executable path
  while (p < end && !*p) ++p;  // its padding
  for (int i = 0; i < argc; ++i) {
    const char* start = p;
    while (p < end && *p) ++p;
    if (p == end) return false;  // an unterminated string: not a whole argv
    argv->emplace_back(start, static_cast<size_t>(p - start));
    ++p;
  }
  return true;
}

napi_value proc_info(napi_env env, napi_callback_info info) {
  int pid = 0;
  if (!int_arg(env, info, "procInfo", "pid", 1, &pid)) return nullptr;
  napi_value null_value = nullptr;
  if (!ok(env, napi_get_null(env, &null_value))) return nullptr;

  struct proc_bsdinfo bsd;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof bsd) != static_cast<int>(sizeof bsd)) return null_value;
  char exe[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath(pid, exe, sizeof exe) <= 0) return null_value;
  std::vector<std::string> argv;
  if (!read_argv(pid, &argv)) return null_value;

  napi_value obj = nullptr, value = nullptr, list = nullptr;
  if (!ok(env, napi_create_object(env, &obj))) return nullptr;
  if (!ok(env, napi_create_int32(env, pid, &value)) || !set(env, obj, "pid", value)) return nullptr;
  if (!ok(env, napi_create_uint32(env, bsd.pbi_ppid, &value)) || !set(env, obj, "ppid", value)) return nullptr;
  if (!ok(env, napi_create_string_utf8(env, exe, NAPI_AUTO_LENGTH, &value)) || !set(env, obj, "path", value)) return nullptr;
  if (!ok(env, napi_create_array_with_length(env, argv.size(), &list))) return nullptr;
  for (size_t i = 0; i < argv.size(); ++i) {
    if (!ok(env, napi_create_string_utf8(env, argv[i].data(), argv[i].size(), &value))) return nullptr;
    if (!ok(env, napi_set_element(env, list, static_cast<uint32_t>(i), value))) return nullptr;
  }
  return set(env, obj, "argv", list) ? obj : nullptr;
}

// ── teamId and processTeamId ─────────────────────────────────────────

std::string utf8(CFStringRef s) {
  CFIndex max = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), kCFStringEncodingUTF8) + 1;
  std::string out(static_cast<size_t>(max), '\0');
  if (!CFStringGetCString(s, out.data(), max, kCFStringEncodingUTF8)) return "";
  out.resize(std::strlen(out.c_str()));
  return out;
}

// The team a signature names (kSecCodeInfoTeamIdentifier), or "". Only its signer's word until vendor_requirement holds.
std::string named_team(SecStaticCodeRef code) {
  std::string team;
  CFDictionaryRef signing = nullptr;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &signing) == errSecSuccess && signing) {
    CFTypeRef value = CFDictionaryGetValue(signing, kSecCodeInfoTeamIdentifier);  // owned by `signing`
    if (value && CFGetTypeID(value) == CFStringGetTypeID()) team = utf8(static_cast<CFStringRef>(value));
  }
  if (signing) CFRelease(signing);
  return team;
}

// `anchor apple generic and certificate leaf[subject.OU] = "<team>"`: an Apple-issued certificate vouches for the team.
// A check with no requirement passes any intact signature, a self-signed one included. Null when the team is not
// capital letters and digits (all a team ID is, and all that can be quoted into the requirement safely); the caller
// releases the rest.
SecRequirementRef vendor_requirement(const std::string& team) {
  if (team.empty() || team.size() > 32 || team.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") != std::string::npos) return nullptr;
  std::string text = "anchor apple generic and certificate leaf[subject.OU] = \"" + team + "\"";
  CFStringRef cf = CFStringCreateWithCString(kCFAllocatorDefault, text.c_str(), kCFStringEncodingUTF8);
  if (!cf) return nullptr;
  SecRequirementRef requirement = nullptr;
  OSStatus status = SecRequirementCreateWithString(cf, kSecCSDefaultFlags, &requirement);
  CFRelease(cf);
  if (status == errSecSuccess) return requirement;
  if (requirement) CFRelease(requirement);
  return nullptr;
}

// The team that signed the file at `file`, or "" when there is none to trust. This hashes the whole file.
std::string signing_team(const std::string& file) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, reinterpret_cast<const UInt8*>(file.data()),
                                                         static_cast<CFIndex>(file.size()), false);
  if (!url) return "";
  SecStaticCodeRef code = nullptr;
  OSStatus status = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
  CFRelease(url);
  if (status != errSecSuccess || !code) {
    if (code) CFRelease(code);
    return "";
  }
  std::string team = SecStaticCodeCheckValidity(code, kSecCSDefaultFlags, nullptr) == errSecSuccess ? named_team(code) : "";
  SecRequirementRef requirement = vendor_requirement(team);
  if (!requirement || SecStaticCodeCheckValidity(code, kSecCSDefaultFlags, requirement) != errSecSuccess) team.clear();
  if (requirement) CFRelease(requirement);
  CFRelease(code);
  return team;
}

// The team that signed the code process `pid` runs, or "" when there is none to trust. SecCodeCheckValidity checks
// the kernel's view of the running code, and fails (errSecCSStaticCodeChanged) when the file at its path is no longer
// what was loaded, so a vendor's binary renamed over a running program's path does not lend it the vendor's team.
std::string running_team(int pid) {
  CFNumberRef number = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &pid);
  if (!number) return "";
  const void* keys[] = {kSecGuestAttributePid};
  const void* values[] = {number};
  CFDictionaryRef attributes = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                                                  &kCFTypeDictionaryValueCallBacks);
  CFRelease(number);
  if (!attributes) return "";
  SecCodeRef code = nullptr;
  OSStatus status = SecCodeCopyGuestWithAttributes(nullptr, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  if (status != errSecSuccess || !code) {
    if (code) CFRelease(code);
    return "";
  }
  std::string team = named_team(code);
  SecRequirementRef requirement = vendor_requirement(team);
  if (!requirement || SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement) != errSecSuccess) team.clear();
  if (requirement) CFRelease(requirement);
  CFRelease(code);
  return team;
}

napi_value team_value(napi_env env, const std::string& team) {
  napi_value out = nullptr;
  napi_status status = team.empty() ? napi_get_null(env, &out) : napi_create_string_utf8(env, team.data(), team.size(), &out);
  return ok(env, status) ? out : nullptr;
}

napi_value team_id(napi_env env, napi_callback_info info) {
  std::string file;
  return path_arg(env, info, "teamId", &file) ? team_value(env, signing_team(file)) : nullptr;
}

napi_value process_team_id(napi_env env, napi_callback_info info) {
  int pid = 0;
  return int_arg(env, info, "processTeamId", "pid", 1, &pid) ? team_value(env, running_team(pid)) : nullptr;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"peerPid", nullptr, peer_pid, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"procInfo", nullptr, proc_info, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"teamId", nullptr, team_id, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
      {"processTeamId", nullptr, process_team_id, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
  };
  return napi_define_properties(env, exports, sizeof props / sizeof props[0], props) == napi_ok ? exports : nullptr;
}
