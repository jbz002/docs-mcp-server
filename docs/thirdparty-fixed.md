文档中心

｜

应用开发

开发指南

服务端API

客户端JSAPI

事件订阅

钉钉CLI

# 第三方访问接口的签名计算方法

![AI 智能摘要](https://gw.alicdn.com/imgextra/i4/O1CN01Zx4PED22rkUkmRe1L_!!6000000007174-2-tps-226-40.png)![\>](https://gw.alicdn.com/imgextra/i2/O1CN01UwOv1C27lrTuGFj2D_!!6000000007838-2-tps-17-30.png)

更新于 2026-07-21本文介绍第三方应用在调用特定钉钉服务端接口时所需的签名计算方法。该机制主要用于提升接口调用的安全性，防止请求被篡改或重放攻击。

## **使用场景**

本签名方法适用于 **第三方企业应用**（ISV 应用），第三方在调用[获取定制应用的accessToken](https://open.dingtalk.com/document/development/obtain-the-access-token-of-the-third-party-application-authorization-enterprise#)接口获取access\_token，或调用[获取企业授权信息](https://open.dingtalk.com/document/development/obtains-the-basic-information-of-an-enterprise#)接口获取授权企业信息时，钉钉会对请求进行签名验证，用以提升安全水位。

**说明**

以上两个接口在钉钉SDK调用中已自带签名功能，开发者无需写代码计算签名，只需传入相关参数即可。

## 签名计算步骤

### 构造签名原文字符串

第三方系统需将当前时间戳与`suiteTicket` 按指定格式拼接成原始字符串。

具体操作如下：

1.  获取当前时间戳（单位：毫秒）。
    
2.  获取有效的`suiteTicket`（测试环境可使用占位符如`TestSuiteTicket`，生产环境必须通过事件订阅实时获取）。
    
3.  将二者以换行符`\n`连接，形成签名原文。
    

对应的签名字符串为： `timestamp+"\n"+suiteTicket`

### 使用 HmacSHA256 计算签名并进行 Base64 编码

把`timestamp+"\n"+suiteTicket`当做签名字符串，suiteSecret/customSecret做为签名密钥，使用HmacSHA256算法计算签名。

### 对签名结果进行 URL Encode 并附加到请求 URL

将 Base64 编码后的签名字符串进行 URL 安全编码（即`URLEncoder`处理），特别注意替换`+`为`%20`、`*` 为`%2A`等特殊字符。

## 签名参数说明

|     |     |
| --- | --- |
| **参数** | **说明** |
| timestamp | 当前时间戳，单位是毫秒。用于防止重放攻击。 |
| suiteTicket | 钉钉给应用推送的ticket，测试应用随意填写如：TestSuiteTicket，正式应用需要从推送回调获取suiteTicket。 |
| suiteSecret/customSecret | 三方应用或者定制应用的密钥。 |

## **代码示例**

### **签名计算（Java）**

```java
String stringToSign = timestamp+"\n"+suiteTicket;
Mac mac = Mac.getInstance("HmacSHA256");
mac.init(new SecretKeySpec(suiteSecret.getBytes("UTF-8"), "HmacSHA256"));
byte[] signData = mac.doFinal(stringToSign.getBytes("UTF-8"));
return new String(Base64.encodeBase64(signData));
```

### **urlEncode（Java）**

```java
// encoding参数使用utf-8
public static String urlEncode(String value, String encoding) {
    if (value == null) {
        return "";
    }
    try {
        String encoded = URLEncoder.encode(value, encoding);
        return encoded.replace("+", "%20").replace("*", "%2A")
            .replace("~", "%7E").replace("/", "%2F");
    } catch (UnsupportedEncodingException e) {
        throw new IllegalArgumentException("FailedToEncodeUri", e);
    }
}
```

### **CURL**

```javascript
curl 'https://oapi.dingtalk.com/service/get_corp_token?signature=xxxxxxxO&timestamp=1527130370219&suiteTicket=xxx&accessKey=suitexxxxxxxx' -d '{"auth_corpid":"auth_corpid"}'
```

遇到其他问题？问问![AI](https://gw.alicdn.com/imgextra/i2/O1CN01IRtISO1hvJeLvBwMi_!!6000000004339-2-tps-72-72.png)钉钉开发助手

如何计算钉钉开放平台API请求的签名（signature）![\>](https://img.alicdn.com/imgextra/i2/O1CN01lIEFYz1lHFTpu1MLd_!!6000000004793-2-tps-48-48.png)![\>](https://img.alicdn.com/imgextra/i4/O1CN01xqKqVA1svjnvuwepR_!!6000000005829-2-tps-48-48.png)

suiteTicket 的获取方式和有效期是什么![\>](https://img.alicdn.com/imgextra/i2/O1CN01lIEFYz1lHFTpu1MLd_!!6000000004793-2-tps-48-48.png)![\>](https://img.alicdn.com/imgextra/i4/O1CN01xqKqVA1svjnvuwepR_!!6000000005829-2-tps-48-48.png)

timestamp 参数的时间单位和时区要求是什么![\>](https://img.alicdn.com/imgextra/i2/O1CN01lIEFYz1lHFTpu1MLd_!!6000000004793-2-tps-48-48.png)![\>](https://img.alicdn.com/imgextra/i4/O1CN01xqKqVA1svjnvuwepR_!!6000000005829-2-tps-48-48.png)

调用钉钉API时URL编码需注意哪些规范（如编码字符集、保留字符等）![\>](https://img.alicdn.com/imgextra/i2/O1CN01lIEFYz1lHFTpu1MLd_!!6000000004793-2-tps-48-48.png)![\>](https://img.alicdn.com/imgextra/i4/O1CN01xqKqVA1svjnvuwepR_!!6000000005829-2-tps-48-48.png)

 [上一篇：个人免登场景的签名计算方法](https://open.dingtalk.com/document/development/signature-personal-registration)[下一篇：RSA私钥对参数进行签名](https://open.dingtalk.com/document/development/rsa-private-key-to-sign-parameters-1) 

![鼠标选中内容，AI智能解释](https://gw.alicdn.com/imgextra/i2/O1CN01oWGgE51qji9lhaeEf_!!6000000005532-2-tps-632-254.png)

鼠标选中内容，AI智能解释

选中存在疑惑的内容，即可快速唤起AI解释反馈

![开发助手](https://gw.alicdn.com/imgextra/i2/O1CN01IRtISO1hvJeLvBwMi_!!6000000004339-2-tps-72-72.png)

开发助手

![AI](https://gw.alicdn.com/imgextra/i2/O1CN01dsAxnc28DLFNCEhSc_!!6000000007898-2-tps-72-65.png) 智能解释

![](https://img.alicdn.com/imgextra/i2/O1CN01nfMLjd1J3gVl8RKuB_!!6000000000973-2-tps-200-200.png) 文档反馈
