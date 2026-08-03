[登录](https://login.dingtalk.com/oauth2/auth?redirect_uri=https%3A%2F%2Fopen.dingtalk.com%2Fdingtalk_sso_call_back%3Fcontinue%3Dhttps%3A%2F%2Fopen.dingtalk.com%2Fdocument%2Fdevelopment%2Frsa-private-key-to-sign-parameters-1&response_type=code&client_id=dingbakuoyxavyp5ruxw&scope=openid+corpid)

API 调用指南

事件订阅

认证与授权

应用授权

通讯录管理

考勤

日程

公告

签到

日志

宜搭

Agoal

音视频

AI 表格

OA 审批

文档/文件

即时通信

待办任务

专属钉钉

钉钉应用

应用市场

组织大脑

智能人事

智能招聘

智能填表

企业文化

钉钉快办

钉钉工作台

行业与生态

炼丹炉（模型服务）

Teambition 项目管理

更多开放

签名计算方法

个人免登场景的签名计算方法

第三方访问接口的签名计算方法

RSA私钥对参数进行签名

平台公告与计费

历史文档（不推荐）

## RSA私钥对参数进行签名

![AI 智能摘要](https://gw.alicdn.com/imgextra/i4/O1CN01Zx4PED22rkUkmRe1L_!!6000000007174-2-tps-226-40.png) ![\>](https://gw.alicdn.com/imgextra/i2/O1CN01UwOv1C27lrTuGFj2D_!!6000000007838-2-tps-17-30.png) 更新于 2026-01-22本文介绍了通过RSA私钥对请求参数进行数字签名的计算方法。RSA加密算法是目前广泛使用的非对称加密算法，常用于数字签名和数据安全传输。在调用API接口时，为保障通信安全，系统间需通过签名机制实现身份认证，防止数据被篡改或抵赖。

## 使用场景

本功能适用于企业内部应用或第三方企业应用，在调用钉钉开放平台中涉及资金操作或敏感数据交互的接口时使用。典型场景包括：

-   红包发放（如企业红包、群红包）
    
-   代扣支付
    
-   敏感业务数据提交
    

**安全目标** ：

-   **防篡改** ：确保请求参数在传输过程中未被修改。
    
-   **防重放** ：结合时间戳、随机数等机制可防止请求被重复使用。
    
-   **身份认证** ：通过私钥签名验证调用方身份，保障通信双方可信。
    

> **指引说明** ：示例代码中的privateKeyStr和publicKeyStr由企业生成，提供公钥给钉钉侧，私钥由企业妥善保管，不可泄露。

## 签名计算方法

1.  将所有非空和非NULL参数放到Map集合M中。
    
2.  将集合M内参数按照 **参数名ASCII码从小到大排序** （字典序）。
    
3.  使用URL键值对的格式（即key1=value1&key2=value2…）拼接成字符串plainString。
    
    **说明**
    
    如果参数的值为空或为NULL不参与签名。
    
4.  对 `plainString` 进行Base64编码，得到 `plainBase64String` 。
    
5.  使用企业私钥，通过 `SHA256withRSA` 算法对 `plainBase64String` 进行签名，生成字节数组 `signBytes` 。
    
6.  对 `signBytes` 进行Base64编码，获得最终的 `signString` ，该值将作为接口请求中的 `pay_sign` 参数传入。
    

## 签名计算代码示例（Java）

## 常见异常及处理

以下是签名过程中可能抛出的常见异常及其原因与解决方案：

|     |     |     |
| --- | --- | --- |
| 异常类型 | 可能成因 | 解决方案 |
| `InvalidKeyException` | 提供的私钥格式错误或不符合PKCS#8标准 | 确保私钥为PKCS#8格式的Base64编码字符串。 |
| `NoSuchAlgorithmException` | 指定的加密算法（如"RSA"或"SHA256withRSA"）不可用 | 检查JDK版本是否支持对应算法；避免手动修改算法名称大小写。 |
| `NullPointerException` | 输入参数（如privateKeyStr、plainStr）为null | 在调用前增加判空检查逻辑。 |
| `IllegalArgumentException` | Base64解码失败（如包含非法字符） | 确保私钥字符串是合法的Base64编码。 |
| `SignatureException` | 签名过程出错（如update或sign阶段） | 检查输入数据是否为空；确认JVM安全策略允许相应操作。 |

> **建议** ：生产环境中应对私钥读取、签名逻辑添加日志记录和异常捕获机制，便于问题排查。

本页内容

![鼠标选中内容，AI智能解释](https://gw.alicdn.com/imgextra/i2/O1CN01oWGgE51qji9lhaeEf_!!6000000005532-2-tps-632-254.png)

鼠标选中内容，AI智能解释

选中存在疑惑的内容，即可快速唤起AI解释反馈

![AI](https://gw.alicdn.com/imgextra/i2/O1CN01dsAxnc28DLFNCEhSc_!!6000000007898-2-tps-72-65.png) 智能解释
