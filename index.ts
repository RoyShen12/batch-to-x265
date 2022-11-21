import child_process from 'child_process'
import fs from 'fs'
import path from 'path'

import { FFMpegProgress } from 'ffmpeg-progress-wrapper'
import chalk from 'chalk'
import { throttle } from 'lodash'
import ProgressBar from 'progress'

interface Progress {
  drop: number
  dup: number
  speed: number
  fps: number
  eta: number
  progress: number
  bitrate: number
}

let inputPath = path.resolve(process.argv[2] || '.')

if (inputPath.endsWith('"')) inputPath = inputPath.slice(0, -1)

const exts = [
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
]
  .map(ext => [ext, ext.toUpperCase()])
  .flat()
  .map(ext => `.${ext}`)

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

let onWriteFile = ''

async function main(workFileOrPath?: string) {
  workFileOrPath = workFileOrPath || inputPath

  if (fs.statSync(workFileOrPath).isDirectory()) {
    console.log(`working dir: ${chalk.bold(chalk.whiteBright(workFileOrPath))}`)

    const files = fs
      .readdirSync(workFileOrPath)
      .map(file => path.resolve(workFileOrPath as string, file))
      .sort()

    for (const file of files) {
      const fileStat = fs.statSync(file)

      if (fileStat.isDirectory()) {
        console.log(`change directory into ${chalk.bold(chalk.whiteBright(file))}`)

        // child_process.execSync(`ts-node index.ts ${file}`)
        await main(file)

        console.log('back to parent directory')
      } else if (fileStat.isFile()) {
        console.log(`switch to file ${chalk.bold(chalk.whiteBright(file))}`)

        // check file is video ext
        if (exts.some(ext => file.endsWith(ext))) {
          // check file is not hevc
          let ffprobeRes = ''
          try {
            ffprobeRes = child_process.execSync(`ffprobe -v quiet -show_format -show_streams "${file}"`).toString()
          } catch {}

          const codecLine = ffprobeRes
            .split(/\r|\n/)
            .filter(line => /codec_name=\w+/.test(line))
            .join(' ')
          // console.log(`codecLine: ${codecLine}`)

          if (codecLine !== '' && !codecLine.includes('codec_name=hevc')) {
            let outputFile = file.replace(/\.[^.]+$/, '.mp4')

            if (outputFile === file) {
              outputFile = file.replace(/\.[^.]+$/, '.x265.mp4')
            }

            if (outputFile === file) {
              outputFile = file.replace(/\.[^.]+$/, '-x265.mp4')
            }

            console.log(`process file ${chalk.bold(chalk.whiteBright(file))}`)
            console.log(`output assume at ${chalk.bold(chalk.blueBright(outputFile))}`)

            const originSize = fileStat.size

            // const cmd = `ffmpeg -y -hwaccel auto -i "${file}" -c:v libx265 -preset fast -crf 28 -tag:v hvc1 -c:a copy "${outputFile}"`
            // console.log(`ffmpeg command: ${chalk.bold(chalk.cyanBright(cmd))}`)
            // child_process.execSync(cmd)
            const process = new FFMpegProgress([
              '-y',
              '-hwaccel',
              'auto',
              '-i',
              file,
              '-c:v',
              'libx265',
              '-preset',
              'fast',
              '-crf',
              '28',
              '-tag:v',
              'hvc1',
              '-c:a',
              'copy',
              outputFile,
            ])

            const progressBar = new ProgressBar(`[:bar] :percent :speed :size :bitrate :etasec time: :time`, {
              incomplete: ' ',
              complete: '-',
              width: (process.stdout as any).columns - 44,
              total: 100,
            })

            onWriteFile = outputFile
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
                const bitrateStr = bitrate > 1024 ? `${(bitrate / 1024).toFixed(1)}mbps` : `${bitrate.toFixed(1)}kbps`

                const speed = Number(raw.match(/speed=\s*(\d+\.\d+)x/)?.[1] || 0)
                const speedStr = speed + 'x'

                const size = raw.match(/size=\s*(\d+kB)/)?.[1] || '0kB'
                const sizeNum = Number(size.replace('kB', ''))
                const humanSize = sizeNum > 1024 ? `${(sizeNum / 1024).toFixed(2)}MB` : `${sizeNum}kB`

                const processPercent = (ffmpegTimeStampToSeconds(time) / ffmpegTimeStampToSeconds(fullDuration)) * 100
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

            onWriteFile = ''

            const outFileSize = fs.statSync(outputFile).size

            console.log(
              chalk.greenBright(
                'ffmpeg run finish, space saved: ' +
                  chalk.bold(chalk.whiteBright(`${(((originSize - outFileSize) / originSize) * 100).toFixed(1)}%`))
              )
            )

            fs.unlinkSync(file)
            console.log(`delete origin file ${chalk.bold(chalk.redBright(file))}`)
          }
        }
      }
    }
  }
}

main()

// delete half-written files on exit
// process.on('exit', () => {
//   try {
//     if (onWriteFile) fs.unlinkSync(onWriteFile)
//   } catch {}
// })
