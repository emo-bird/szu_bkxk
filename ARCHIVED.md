# ⚠️ 本分支已归档，不再修改

- **分支名**：`archive/master-tampermonkey-v1`（原 `master-tampermonkey`）
- **归档提交**：`1737736`（最后一次提交，此后再无改动）
- **归档原因**：实现过度 —— 产物 234KB、359 项测试，远超项目实际需要。
  其功能与纪律被重新梳理为 v2，见分支 **`master-tampermonkey-v2`**。

## 这里还有什么用

**唯一用途：当参考库查。** 有价值的是已经过验证的**结论**，不是代码本身。

| 想查什么 | 去哪看 |
| --- | --- |
| 接口逆向取证（报文、字段、鉴权、DOM 选择器） | `docs/接口逆向记录.md` ★最有用 |
| 早前那版方案与取舍 | `docs/方案-油猴脚本.md` |
| v1 的实现细节（仅当需要对照） | `src/` |

**不要在这里继续开发。** 新工作一律在 `master-tampermonkey-v2` 上做。

## 从零拿到接口结论

```powershell
git show archive/master-tampermonkey-v1:docs/接口逆向记录.md
```
