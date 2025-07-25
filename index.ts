import child_process from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { program } from 'commander'
import { FFMpegProgress } from 'ffmpeg-progress-wrapper'
import chalk from 'chalk'
import { throttle } from 'lodash'
import ProgressBar from 'progress'

// 提取常量
const VIDEO_CODECS = ['wmav2', 'wmav1', 'wmapro']
const SUPPORTED_EXTENSIONS = [
  'avi',
  'wmv',
  'rmvb',
  'rm',
  'asf',
  'divx',
  'mpg',
  'mpeg',
  'mpe',
  'mp4',
  'mkv',
  'mov',
  'vob',
  '3gp',
  'flv',
  'mpg',
  'ts',
  'webm',
  'm4v',
  'f4v',
  'f4p',
  'f4a',
  'f4b',
  'mts',
]
  .map(ext => [ext, ext.toUpperCase()])
  .flat()
  .map(ext => `.${ext}`)

const X265_ENCODER = 'libx265'
const DEFAULT_PRESET = 'fast'
const DEFAULT_CRF = '25'
// 添加并发控制常量
const MAX_CONCURRENT_PROCESSING = 3

// 创建生成输出文件名的函数
function generateOutputFileName(file: string): string {
  let outputFile = file.replace(/\.[^.]+$/, '.mp4')

  // 如果输出文件名与原文件名相同，则添加.x265后缀
  if (
    outputFile === file ||
    (os.platform() === 'darwin' && outputFile.toLowerCase() === file.toLowerCase())
  ) {
    outputFile = file.replace(/\.[^.]+$/, '.x265.mp4')
  }

  // 如果仍然相同，则尝试使用-分隔符
  if (
    outputFile === file ||
    (os.platform() === 'darwin' && outputFile.toLowerCase() === file.toLowerCase())
  ) {
    outputFile = file.replace(/\.[^.]+$/, '-x265.mp4')
  }

  // 如果仍然相同，则尝试使用空格分隔符
  if (
    outputFile === file ||
    (os.platform() === 'darwin' && outputFile.toLowerCase() === file.toLowerCase())
  ) {
    outputFile = file.replace(/\.[^.]+$/, ' x265.mp4')
  }

  return outputFile
}

// 创建解析ffprobe结果的函数
function parseFfprobeResult(ffprobeRes: string) {
  // 使用正则表达式直接提取所需信息，提高效率
  const codecMatch = ffprobeRes.match(/codec_name=(\w+)/)
  const widthMatch = ffprobeRes.match(/coded_width=(\d+)/)
  const heightMatch = ffprobeRes.match(/coded_height=(\d+)/)
  
  return {
    codecLine: codecMatch ? codecMatch[0] : '',
    videoWidth: widthMatch ? parseInt(widthMatch[1], 10) : -1,
    videoHeight: heightMatch ? parseInt(heightMatch[1], 10) : -1
  }
}

// 改进错误处理函数
function handleConversionError(error: unknown, retry: number) {
  console.log(chalk.bold(chalk.yellowBright(`\nffmpeg conversion error (attempt ${retry + 1}/3)`)))
  
  if (error instanceof Error) {
    console.log(chalk.bold(chalk.redBright(error.message)))
    
    // 如果有堆栈信息，也显示出来
    if (error.stack) {
      console.log(chalk.gray(error.stack))
    }
  } else {
    console.log(chalk.bold(chalk.redBright(String(error))))
  }
}

// 创建并发控制函数
async function processFilesWithConcurrency(files: string[], processFile: (file: string) => Promise<void>, concurrency: number) {
  const chunks = []
  for (let i = 0; i < files.length; i += concurrency) {
    chunks.push(files.slice(i, i + concurrency))
  }
  
  for (const chunk of chunks) {
    await Promise.all(chunk.map(file => processFile(file)))
  }
}

program
  .option('-r, --reverse', '反向处理文件')
  .option('--aac', '强制使用AAC音频编码')
  .option('-p, --path <path>', '指定处理路径')
  .option('--preset <preset>', '编码预设', DEFAULT_PRESET)
  .option('--crf <crf value>', '恒定速率因子', DEFAULT_CRF)
  .option('--res <resolution>', '限制分辨率')
  .option('--show-command', '显示FFmpeg命令')
  // 添加并发控制选项
  .option('--concurrency <number>', '并发处理文件数', String(MAX_CONCURRENT_PROCESSING))

program.parse()

const options = program.opts()

console.log('options', options)

let inputPath = path.resolve(options.path || '.')

if (inputPath.endsWith('"')) inputPath = inputPath.slice(0, -1)

const forceAAC = options.aac
// 获取并发数
const concurrency = Math.max(1, Math.min(10, parseInt(options.concurrency) || MAX_CONCURRENT_PROCESSING))

const reportRawProgress = throttle(function (c) {
  console.log(c)
}, 1000)

const ffmpegTimeStampToSeconds = (timeStamp: string) => {
  try {
    const [hours, minutes, seconds] = timeStamp.split(':').map(Number)
    return hours * 3600 + minutes * 60 + seconds
  } catch (error) {
    return 0
  }
}

let lastLock = ''

let programStat = {
  originSize: 0,
  outputSize: 0,
}

// 提取文件处理逻辑为独立函数
async function processFile(file: string) {
  let fileStat: fs.Stats | undefined

  try {
    fileStat = fs.statSync(file)
  } catch (error) {
    console.error(chalk.red(`Error accessing file ${file}:`), error)
    return
  }

  if (fileStat?.isDirectory()) {
    console.log(`change directory into ${chalk.bold(chalk.whiteBright(file))}`)

    // child_process.execSync(`ts-node index.ts ${file}`)
    await main(file)

    console.log('back to parent directory')
  } else if (fileStat?.isFile()) {
    // 检查文件扩展名是否为支持的视频格式
    if (SUPPORTED_EXTENSIONS.some(ext => file.endsWith(ext))) {
      // 跳过已经转换的文件
      if (
        file.toLowerCase().endsWith('.x265.mp4') ||
        file.toLowerCase().endsWith('-x265.mp4') ||
        file.toLowerCase().endsWith(' x265.mp4')
      )
        return

      // 检查文件是否不是HEVC编码
      let ffprobeRes = ''
      try {
        ffprobeRes = child_process.execSync(`ffprobe -v quiet -show_format -show_streams "${file}"`).toString()
      } catch (error) {
        console.error(chalk.red(`Error probing file ${file}:`), error)
        return
      }

      // 使用新创建的函数解析ffprobe结果
      const { codecLine, videoWidth, videoHeight } = parseFfprobeResult(ffprobeRes)

      // 如果是HEVC编码，则跳过
      if (codecLine !== '' && !codecLine.includes('codec_name=hevc')) {
        // 使用新创建的函数生成输出文件名
        const outputFile = generateOutputFileName(file)

        const lockFile = `${file}.lock`

        // 检查文件是否被锁定
        if (fs.existsSync(lockFile)) {
          console.log(`skip ${chalk.bold(chalk.whiteBright(file))} because it is locked`)
          return
        } else {
          fs.writeFileSync(lockFile, '')
          lastLock = lockFile
        }

        console.log(
          `process file ${chalk.bold(
            chalk.whiteBright(file)
          )} codecLine: ${codecLine}, videoSize: ${videoWidth}x${videoHeight}`
        )
        console.log(`output assume at ${chalk.bold(chalk.blueBright(outputFile))}`)

        const originSize = fileStat.size

        let retry = 0
        let conversionSuccess = false
        while (retry < 3 && !conversionSuccess) {
          try {
            if (retry > 0) {
              console.log(`retry ${chalk.bold(chalk.redBright(retry))}`)
            }
            // const cmd = `ffmpeg -y -hwaccel auto -i "${file}" -c:v libx265 -preset fast -crf 28 -tag:v hvc1 -c:a copy "${outputFile}"`
            // console.log(`ffmpeg command: ${chalk.bold(chalk.cyanBright(cmd))}`)
            // child_process.execSync(cmd)
            const audioForm =
              forceAAC || VIDEO_CODECS.some(codec => codecLine.includes(codec)) ? 'aac' : 'copy'

            const limitResolution = options.res ? ['-vf', `scale=-1:${options.res}`] : []

            const command = [
              '-y',
              '-hwaccel',
              'auto',
              '-i',
              file,
              ...limitResolution,
              '-c:v',
              X265_ENCODER,
              '-preset',
              options.preset,
              '-crf',
              options.crf,
              '-tag:v',
              'hvc1',
              '-c:a',
              audioForm,
              outputFile,
            ]
            if (options.showCommand) {
              console.log(command.join(' '))
            }
            const process = new FFMpegProgress(command)

            const progressBar = new ProgressBar(`[:bar] :percent :speed :size :bitrate :etasec time: :time`, {
              incomplete: ' ',
              complete: '-',
              width: (process.stdout as any).columns - 44,
              total: 100,
            })

            let fullDuration = ''
            let fullDurationStr = ''

            process.on('raw', (raw: string) => {
              if (/Duration: \d+:\d+:\d+\.\d+/.test(raw)) {
                fullDuration = raw.match(/Duration: (\d+:\d+:\d+\.\d+)/)?.[1] || ''
                fullDurationStr = fullDuration
                if (fullDurationStr.startsWith('00:')) {
                  fullDurationStr = fullDurationStr.slice(3)
                }
                fullDurationStr = chalk.bold(chalk.magentaBright(fullDurationStr))
              }

              if (typeof raw === 'string' && raw.includes('speed=')) {
                const time = raw.match(/time=(\d+:\d+:\d+\.\d+)/)?.[1] || ''
                let timeHuman = time
                if (timeHuman.startsWith('00:')) {
                  timeHuman = timeHuman.slice(3)
                }

                const bitrate = Number(raw.match(/bitrate=\s*(\d+\.\d+)kbits\/s/)?.[1] || 0)
                const bitrateStr =
                  bitrate > 1024 ? `${(bitrate / 1024).toFixed(1)}mbps` : `${bitrate.toFixed(1)}kbps`

                const speed = Number(raw.match(/speed=\s*(\d+\.\d+)x/)?.[1] || 0)
                const speedStr = speed + 'x'

                const size = raw.match(/size=\s*(\d+kB)/)?.[1] || '0kB'
                const sizeNum = Number(size.replace('kB', ''))
                const humanSize = sizeNum > 1024 ? `${(sizeNum / 1024).toFixed(2)}MB` : `${sizeNum}kB`

                const processPercent =
                  (ffmpegTimeStampToSeconds(time) / ffmpegTimeStampToSeconds(fullDuration)) * 100
                const processPercentStr = processPercent.toFixed(1) + '%'

                // [bar] 100% 99.99x 19999.9MB 9999.9kbps 99999.9sec
                progressBar.update(processPercent / 100, {
                  speed: chalk.bold(chalk.redBright(speedStr.padStart(6, ' '))),
                  size: chalk.bold(chalk.blueBright(humanSize.padStart(9, ' '))),
                  bitrate: chalk.bold(chalk.yellowBright(bitrateStr.padStart(10, ' '))),
                  time: chalk.bold(chalk.greenBright(timeHuman)) + '/' + fullDurationStr,
                })
              }
            })

            // process.once('details', (details) => console.log(JSON.stringify(details)));

            // process.on('progress', (progress: Progress) => {
            //   console.log(
            //     `${chalk.bold(chalk.whiteBright(`${((progress?.progress || 0) * 100).toFixed(1)}%`))} | ${chalk.bold(
            //       chalk.yellowBright(`${((progress?.bitrate || 0) / 1000).toFixed(0)} kbps`)
            //     )} | ${chalk.bold(chalk.magentaBright(`${progress?.fps || 0} fps`))} | ${chalk.bold(
            //       chalk.cyanBright(`${moment.duration(progress?.eta || 0, 'seconds').humanize()}`)
            //     )}`
            //   )
            // })

            // process.once('end', console.log.bind(console, 'Conversion finished and exited with code'));

            await process.onDone()

            conversionSuccess = true
          } catch (error) {
            // 使用新创建的错误处理函数
            handleConversionError(error, retry)
            retry += 1

            if (retry < 3) {
              console.log(chalk.yellow(`Waiting 1 second before retrying...`))
              await new Promise(resolve => setTimeout(resolve, 1000))
            }
          }
        }

        if (conversionSuccess) {
          const outFileSize = fs.statSync(outputFile).size

          programStat.originSize += originSize
          programStat.outputSize += outFileSize

          const spaceSavedRate = (((originSize - outFileSize) / originSize) * 100).toFixed(1)
          const totalSpaceSavedRate = (
            ((programStat.originSize - programStat.outputSize) / programStat.originSize) *
            100
          ).toFixed(1)

          console.log(
            chalk.greenBright(
              '\nffmpeg run finish, space saved: ' +
                chalk.bold(chalk.whiteBright(`${spaceSavedRate}%`)) +
                ', total input size: ' +
                chalk.bold(chalk.redBright(`${(programStat.originSize / 1024 / 1024).toFixed(2)}MB`)) +
                ', total output size: ' +
                chalk.bold(chalk.greenBright(`${(programStat.outputSize / 1024 / 1024).toFixed(2)}MB`)) +
                ', total space saved: ' +
                chalk.bold(chalk.whiteBright(`${totalSpaceSavedRate}%`))
            )
          )

          fs.unlinkSync(file)
          console.log(`delete origin file ${chalk.bold(chalk.redBright(file))}`)
        } else {
          console.log(chalk.yellow(`Conversion failed after 3 attempts. Cleaning up...`))
          try {
            fs.unlinkSync(outputFile)
          } catch (error) {
            console.error(chalk.red(`Error deleting output file ${outputFile}:`), error)
          }
        }

        try {
          fs.unlinkSync(lockFile)
        } catch (error) {
          console.error(chalk.red(`Error deleting lock file ${lockFile}:`), error)
        }
      }
    }
  }
}

async function main(workFileOrPath?: string) {
  workFileOrPath = workFileOrPath || inputPath

  if (fs.statSync(workFileOrPath).isDirectory()) {
    console.log(`working dir: ${chalk.bold(chalk.whiteBright(workFileOrPath))}`)

    let files = fs
      .readdirSync(workFileOrPath)
      .map(file => path.resolve(workFileOrPath as string, file))
      .sort()

    if (options.r) {
      files = files.reverse()
    }

    // 使用并发控制处理文件
    await processFilesWithConcurrency(files, processFile, concurrency)
  }
}

main()

process.on('SIGINT', () => {
  console.log(chalk.yellow('\nReceived SIGINT. Cleaning up...'))
  try {
    if (lastLock) {
      fs.unlinkSync(lastLock)
      console.log(chalk.green(`Deleted lock file ${lastLock}`))
    }
  } catch (error) {
    console.error(chalk.red(`Error deleting lock file ${lastLock}:`), error)
  }

  process.exit()
})
