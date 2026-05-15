import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

import type { SelfMadeGlossarySource } from '@/context/GlossaryContext'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export interface ExtractedPdfPage {
  page: number
  text: string
  urls: string[]
  imageDataUrl?: string
}

export interface ExtractedPdfDocument {
  source: SelfMadeGlossarySource
  pages: ExtractedPdfPage[]
}

export interface PdfExtractionOptions {
  renderPageImages?: boolean
  imageScale?: number
  imageType?: 'image/jpeg' | 'image/png'
  imageQuality?: number
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]}]+/gi

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function extractUrls(text: string): string[] {
  return unique(text.match(URL_PATTERN) ?? [])
}

function textItemToString(item: unknown): string {
  if (!item || typeof item !== 'object') return ''
  const value = (item as { str?: unknown }).str
  return typeof value === 'string' ? value : ''
}

function annotationToUrl(annotation: unknown): string | null {
  if (!annotation || typeof annotation !== 'object') return null
  const row = annotation as { url?: unknown; unsafeUrl?: unknown }
  if (typeof row.url === 'string') return row.url
  if (typeof row.unsafeUrl === 'string') return row.unsafeUrl
  return null
}

async function renderPageToDataUrl(page: Awaited<ReturnType<Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>['getPage']>>, options: PdfExtractionOptions): Promise<string> {
  const viewport = page.getViewport({ scale: options.imageScale ?? 1.6 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const canvasContext = canvas.getContext('2d')
  if (!canvasContext) throw new Error('Canvas is not available for PDF page rendering')
  await page.render({ canvas, canvasContext, viewport }).promise
  return canvas.toDataURL(options.imageType ?? 'image/jpeg', options.imageQuality ?? 0.86)
}

export async function extractPdfDocument(file: File, options: PdfExtractionOptions = {}): Promise<ExtractedPdfDocument> {
  const importedAt = new Date().toISOString()
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const pages: ExtractedPdfPage[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const [textContent, annotations] = await Promise.all([
      page.getTextContent(),
      page.getAnnotations(),
    ])
    const text = textContent.items.map(textItemToString).filter(Boolean).join(' ')
    const annotationUrls = (annotations as unknown[]).map(annotationToUrl).filter((url): url is string => Boolean(url))
    const imageDataUrl = options.renderPageImages ? await renderPageToDataUrl(page, options) : undefined
    pages.push({
      page: pageNumber,
      text,
      urls: unique([...extractUrls(text), ...annotationUrls]),
      imageDataUrl,
    })
  }

  return {
    source: {
      id: crypto.randomUUID(),
      kind: 'pdf',
      name: file.name,
      uri: file.name,
      importedAt,
    },
    pages,
  }
}
