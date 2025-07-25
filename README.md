# Batch to x265 Optimizer

这是一个优化过的视频批量转换工具，可将视频文件转换为x265编码格式以节省存储空间。

## 主要优化内容

1. **代码去重**
   - 提取文件名生成逻辑为独立函数
   - 合并重复的ffprobe结果解析逻辑

2. **硬编码值提取**
   - 将视频编解码器和扩展名定义为常量
   - 将FFmpeg配置参数定义为常量

3. **错误处理改进**
   - 添加详细的错误消息和堆栈跟踪
   - 增强文件访问和转换错误处理

4. **性能优化**
   - 优化ffprobe结果解析逻辑
   - 添加并发处理控制

5. **可读性增强**
   - 添加清晰的中文注释
   - 简化条件表达式

6. **类型安全改进**
   - 移除未使用的接口定义

7. **并发控制**
   - 添加--concurrency参数控制并发数
   - 实现基于块的并发处理

8. **CLI文档改进**
   - 为所有命令行选项添加描述和默认值

## 使用方法

```bash
# 显示帮助信息
npx ts-node index.ts --help

# 转换指定目录下的所有视频文件
npx ts-node index.ts -p /path/to/videos

# 使用特定预设和CRF值
npx ts-node index.ts --preset slow --crf 23

# 限制分辨率
npx ts-node index.ts --res 1080

# 设置并发处理数
npx ts-node index.ts --concurrency 5
```

## 编译和运行

```bash
# 编译TypeScript代码
npx tsc

# 运行编译后的JavaScript版本
node dist/index.js --help
```

## 依赖

- Node.js >= 12
- FFmpeg
- FFprobe