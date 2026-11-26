import Foundation
import CoreServices
let status = LSSetDefaultRoleHandlerForContentType(
    "net.daringfireball.markdown" as CFString,
    LSRolesMask.all,
    "com.local.markdownviewer" as CFString)
print("LSSetDefaultRoleHandler status:", status)
