
/*
 * Route: api.innovationbound.com/services/training/chatgpt/accelerator/payment
 * Process payment or invoice request for 2026 AI Accelerator enrollment
 * Supports: Credit card (Stripe) and Invoice requests
 */

import { readFile } from 'fs/promises'
import Stripe from 'stripe'
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import PDFDocument from 'pdfkit'

// TODO: Set STRIPE_SECRET_KEY environment variable
// Test key format: sk_test_...
// Live key format: sk_live_...
var stripe = new Stripe(process.env.STRIPE_KEY)

var ses = new SESClient({ region: 'us-east-1' })
var dynamoDb = new DynamoDBClient({ region: 'us-east-1' })
var db = DynamoDBDocumentClient.from(dynamoDb)
var replyToAddress = "Innovation Bound <support@innovationbound.com>"
var accountingEmail = "accounting@innovationbound.com"

// Valid tier amounts in dollars
var validTiers = {
  '6000': { tier: '6000', fee: '$6,000', seatCost: '$600' },
  '13500': { tier: '13500', fee: '$13,500', seatCost: '$1,350' },
  '21000': { tier: '21000', fee: '$21,000', seatCost: '$2,100' },
  '30000': { tier: '30000', fee: '$30,000', seatCost: '$3,000' }
}

export async function handler (event) {
  console.log('EVENT:', JSON.stringify(event))
  if (event.httpMethod === 'OPTIONS') return respond(204) // For OPTIONS preflight

  try {
    var json = event.body ? JSON.parse(event.body) : event

    // Extract and validate payment data
    var {
      applicant,
      name,
      finalFee,
      additionalSeats,
      paymentMethod,
      company,
      jobTitle,
      phone,
      country,
      paymentMethodId  // For Stripe credit card payments
    } = json

    // Validate required fields
    console.log(`Processing payment for ${applicant}`)

    if (!applicant) return respond(400, {error: 'Applicant email is required.'})
    if (!name) return respond(400, {error: 'Name is required.'})
    if (!finalFee) return respond(400, {error: 'Final fee is required.'})
    if (!paymentMethod) return respond(400, {error: 'Payment method is required.'})
    if (!['credit-card', 'invoice'].includes(paymentMethod)) {
      return respond(400, {error: 'Payment method must be "credit-card" or "invoice".'})
    }
    if (!company) return respond(400, {error: 'Company is required.'})
    if (!jobTitle) return respond(400, {error: 'Job title is required.'})
    if (!phone) return respond(400, {error: 'Phone is required.'})
    if (!country) return respond(400, {error: 'Country is required.'})

    // Validate applicant exists
    var application = await db.send(new GetCommand({
      TableName: "www.innovationbound.com",
      Key: { pk: "application#ai-accelerator", sk: applicant }
    }))

    if (!application.Item) {
      return respond(404, {error: 'Application not found. Please apply first.'})
    }

    // Check if already paid (prevent double charging)
    if (application.Item.paymentStatus === 'paid') {
      return respond(400, {
        error: `Payment already completed for ${application.Item.company || 'this application'} (${application.Item.email}). You enrolled on ${new Date(application.Item.paidAt).toLocaleDateString()}. Contact support@innovationbound.com if you need assistance.`
      })
    }

    // Parse and validate tier
    var tierAmount = parseTierAmount(finalFee)
    if (!tierAmount) {
      return respond(400, {error: 'Invalid tier. Must be $6,000, $13,500, $21,000, or $30,000.'})
    }

    var tierInfo = validTiers[tierAmount]

    // Validate and parse additional seats
    var seats = parseInt(additionalSeats) || 0
    if (seats < 0 || seats > 40) {
      return respond(400, {error: 'Additional seats must be between 0 and 40.'})
    }

    // Calculate total amount (in cents for Stripe)
    var seatPrice = parseInt(tierAmount) * 0.1 // 10% of tier price
    var totalAmount = parseInt(tierAmount) + (seatPrice * seats)
    var totalAmountCents = totalAmount * 100

    console.log(`Tier: ${tierInfo.fee}, Additional seats: ${seats}, Total: $${totalAmount.toLocaleString()}`)

    // Route to appropriate payment flow
    if (paymentMethod === 'credit-card') {
      return await processCreditCardPayment({
        application: application.Item,
        applicant,
        name,
        tierInfo,
        tierAmount,
        seats,
        totalAmount,
        totalAmountCents,
        company,
        jobTitle,
        phone,
        country,
        paymentMethodId
      })
    } else {
      return await processInvoiceRequest({
        application: application.Item,
        applicant,
        name,
        tierInfo,
        tierAmount,
        seats,
        totalAmount,
        totalAmountCents,
        company,
        jobTitle,
        phone,
        country
      })
    }

  } catch (error) {
    console.error('Error:', error)
    return respond(500, {error: 'Payment processing failed. Please try again.'})
  }
}

// Pure: Parses tier amount from formatted string (e.g., "$13,500" -> "13500")
function parseTierAmount (feeString) {
  var cleaned = feeString.replace(/[$,]/g, '')
  var amount = parseInt(cleaned)
  if (validTiers[amount.toString()]) {
    return amount.toString()
  }
  return null
}

// Side effect: Processes credit card payment via Stripe
async function processCreditCardPayment (data) {
  var {
    application,
    applicant,
    name,
    tierInfo,
    tierAmount,
    seats,
    totalAmount,
    totalAmountCents,
    company,
    jobTitle,
    phone,
    country,
    paymentMethodId
  } = data

  try {
    if (!paymentMethodId) {
      return respond(400, {error: 'Payment method ID is required for credit card payments.'})
    }

    console.log(`Processing Stripe payment: $${totalAmount} for ${applicant}`)

    // Create and confirm payment with Stripe
    var paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmountCents,
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never'
      },
      description: `2026 AI Accelerator - ${tierInfo.fee} tier + ${seats} additional seats`,
      metadata: {
        applicant: applicant,
        program: '2026-ai-accelerator',
        tier: tierAmount,
        additionalSeats: seats.toString(),
        company: company
      }
    })

    console.log(`Stripe payment status: ${paymentIntent.status}`)

    if (paymentIntent.status !== 'succeeded') {
      return respond(400, {
        error: 'Payment could not be completed.',
        status: paymentIntent.status,
        requiresAction: paymentIntent.status === 'requires_action'
      })
    }

    // Update application record
    await db.send(new UpdateCommand({
      TableName: "www.innovationbound.com",
      Key: { pk: "application#ai-accelerator", sk: applicant },
      UpdateExpression: "SET paymentMethod = :method, paymentStatus = :status, paymentAmount = :amount, finalFee = :fee, additionalSeats = :seats, company = :company, jobTitle = :title, phone = :phone, country = :country, stripePaymentId = :stripeId, paidAt = :paidAt, enrolled = :enrolled",
      ExpressionAttributeValues: {
        ":method": "credit-card",
        ":status": "paid",
        ":amount": totalAmountCents,
        ":fee": parseInt(tierAmount),
        ":seats": seats,
        ":company": company,
        ":title": jobTitle,
        ":phone": phone,
        ":country": country,
        ":stripeId": paymentIntent.id,
        ":paidAt": new Date().toJSON(),
        ":enrolled": true
      }
    }))

    // Create student record
    await db.send(new PutCommand({
      TableName: "www.innovationbound.com",
      Item: {
        pk: "student#ai-accelerator",
        sk: applicant,
        name: name,
        email: applicant,
        company: company,
        jobTitle: jobTitle,
        phone: phone,
        country: country,
        tier: tierAmount,
        accountOwner: true,
        paymentStatus: "complete",
        amountPaid: totalAmountCents,
        totalAmount: totalAmountCents,
        paymentPlan: "full",
        baseSeats: 10,
        additionalSeats: seats,
        totalSeats: 10 + seats,
        stripePaymentId: paymentIntent.id,
        enrolledAt: new Date().toJSON(),
        paymentMethod: "credit-card"
      }
    }))

    // Send confirmation email
    await sendPaymentConfirmationEmail({
      name,
      email: applicant,
      tierInfo,
      seats,
      totalAmount,
      company
    })

    return respond(200, {
      success: true,
      message: 'Payment successful! Check your email for enrollment confirmation.',
      enrolled: true,
      paymentId: paymentIntent.id
    })

  } catch (error) {
    console.error('Stripe error:', error)

    // Handle Stripe-specific errors
    var errorMessage = 'Payment processing failed.'
    if (error.type === 'StripeCardError') {
      errorMessage = `Payment declined: ${error.message}`
    } else if (error.type === 'StripeInvalidRequestError') {
      errorMessage = 'Invalid payment information.'
    }

    return respond(400, {error: errorMessage, details: error.message})
  }
}

// Side effect: Processes invoice request
async function processInvoiceRequest (data) {
  var {
    application,
    applicant,
    name,
    tierInfo,
    tierAmount,
    seats,
    totalAmount,
    totalAmountCents,
    company,
    jobTitle,
    phone,
    country
  } = data

  try {
    console.log(`Processing invoice request: $${totalAmount} for ${applicant}`)

    // Update application record
    await db.send(new UpdateCommand({
      TableName: "www.innovationbound.com",
      Key: { pk: "application#ai-accelerator", sk: applicant },
      UpdateExpression: "SET paymentMethod = :method, paymentStatus = :status, paymentAmount = :amount, finalFee = :fee, additionalSeats = :seats, company = :company, jobTitle = :title, phone = :phone, country = :country, invoiceRequestedAt = :requestedAt, enrolled = :enrolled",
      ExpressionAttributeValues: {
        ":method": "invoice",
        ":status": "pending",
        ":amount": totalAmountCents,
        ":fee": parseInt(tierAmount),
        ":seats": seats,
        ":company": company,
        ":title": jobTitle,
        ":phone": phone,
        ":country": country,
        ":requestedAt": new Date().toJSON(),
        ":enrolled": false
      }
    }))

    // Create student record (pending payment)
    await db.send(new PutCommand({
      TableName: "www.innovationbound.com",
      Item: {
        pk: "student#ai-accelerator",
        sk: applicant,
        name: name,
        email: applicant,
        company: company,
        jobTitle: jobTitle,
        phone: phone,
        country: country,
        tier: tierAmount,
        accountOwner: true,
        paymentStatus: "pending",
        amountPaid: 0,
        totalAmount: totalAmountCents,
        paymentPlan: null,
        baseSeats: 10,
        additionalSeats: seats,
        totalSeats: 10 + seats,
        enrolledAt: new Date().toJSON(),
        paymentMethod: "invoice"
      }
    }))

    // Send invoice request email
    await sendInvoiceRequestEmail({
      name,
      email: applicant,
      tierInfo,
      seats,
      totalAmount,
      company,
      phone,
      jobTitle
    })

    return respond(200, {
      success: true,
      message: 'Invoice request received! We\'ll send your invoice within 24 hours.',
      enrolled: false,
      pendingPayment: true
    })

  } catch (error) {
    console.error('Invoice request error:', error)
    return respond(500, {error: 'Invoice request failed. Please try again.'})
  }
}

// Pure: Generates invoice PDF and returns base64 encoded string
// status: 'PAID' or 'DUE UPON RECEIPT'
function generateInvoicePDF (data, status = 'DUE UPON RECEIPT') {
  return new Promise((resolve, reject) => {
    var { name, email, company, jobTitle, phone, country, tierInfo, seats, totalAmount } = data

    var doc = new PDFDocument({ size: 'LETTER', margin: 50 })
    var chunks = []

    // Collect PDF data chunks
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => {
      var pdfBuffer = Buffer.concat(chunks)
      var base64PDF = pdfBuffer.toString('base64')
      resolve(base64PDF)
    })
    doc.on('error', reject)

    // Invoice Header
    doc.fontSize(24)
       .fillColor('#1d2731')
       .text('INVOICE', { align: 'right' })

    // Payment Status Badge
    var statusColor = status === 'PAID' ? '#2ecc71' : '#e74c3c'
    doc.fontSize(14)
       .fillColor(statusColor)
       .text(status, { align: 'right' })

    doc.moveDown()

    // Innovation Bound Info
    doc.fontSize(16)
       .fillColor('#1d2731')
       .text('Innovation Bound LLC', 50, 80)

    doc.fontSize(10)
       .fillColor('#666666')
       .text('7903 Seminole BLVD #2303', 50, 105)
       .text('Seminole, FL 33772', 50, 118)
       .text('(212) 602-1401', 50, 131)
       .text('accounting@innovationbound.com', 50, 144)

    // Invoice Details (Right side)
    var invoiceDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    var invoiceNumber = `AI-ACC-2026-${Date.now().toString().slice(-8)}`

    doc.fontSize(10)
       .fillColor('#666666')
       .text(`Invoice Number: ${invoiceNumber}`, 350, 105, { align: 'right' })
       .text(`Date: ${invoiceDate}`, 350, 118, { align: 'right' })
       .text('Due: Net 30', 350, 131, { align: 'right' })

    // Divider
    doc.moveTo(50, 175)
       .lineTo(562, 175)
       .strokeColor('#fdc844')
       .lineWidth(2)
       .stroke()

    // Bill To Section
    doc.moveDown(2)
    doc.fontSize(12)
       .fillColor('#1d2731')
       .text('BILL TO:', 50, 195)

    doc.fontSize(11)
       .fillColor('#333333')
       .text(name, 50, 215)
       .text(jobTitle, 50, 230)
       .text(company, 50, 245)
       .text(email, 50, 260)
       .text(phone, 50, 275)
       .text(country, 50, 290)

    // Line Items Header
    doc.fontSize(11)
       .fillColor('#1d2731')
       .text('DESCRIPTION', 50, 335)
       .text('QTY', 350, 335)
       .text('RATE', 420, 335)
       .text('AMOUNT', 490, 335, { align: 'right' })

    // Divider under header
    doc.moveTo(50, 350)
       .lineTo(562, 350)
       .strokeColor('#cccccc')
       .lineWidth(1)
       .stroke()

    // Line Items
    var yPosition = 365

    doc.fontSize(10)
       .fillColor('#333333')
       .text('2026 AI Accelerator Program', 50, yPosition)
       .text(tierInfo.fee + ' Tier', 50, yPosition + 12, { fontSize: 9, fillColor: '#666666' })
       .text('1', 350, yPosition)
       .text(tierInfo.fee, 420, yPosition)
       .text(tierInfo.fee, 490, yPosition, { align: 'right' })

    yPosition += 45

    if (seats > 0) {
      var seatCost = parseInt(tierInfo.tier) * 0.10
      var seatTotal = seatCost * seats

      doc.fontSize(10)
         .fillColor('#333333')
         .text('Additional Seats', 50, yPosition)
         .text('(10% of tier price per seat)', 50, yPosition + 12, { fontSize: 9, fillColor: '#666666' })
         .text(seats.toString(), 350, yPosition)
         .text(`$${seatCost.toLocaleString()}`, 420, yPosition)
         .text(`$${seatTotal.toLocaleString()}`, 490, yPosition, { align: 'right' })

      yPosition += 45
    }

    // Divider before totals
    doc.moveTo(350, yPosition)
       .lineTo(562, yPosition)
       .strokeColor('#cccccc')
       .lineWidth(1)
       .stroke()

    yPosition += 15

    // Total
    doc.fontSize(12)
       .fillColor('#1d2731')
       .text('TOTAL DUE:', 350, yPosition)
       .fontSize(14)
       .text(`$${totalAmount.toLocaleString()}`, 490, yPosition, { align: 'right' })

    yPosition += 50

    // Payment Terms
    doc.fontSize(10)
       .fillColor('#666666')
       .text('Payment Terms: Net 30 days from invoice date', 50, yPosition)
       .text('Please make checks payable to: Innovation Bound LLC', 50, yPosition + 15)
       .text('Wire transfer details available upon request', 50, yPosition + 30)

    // Logo at bottom center
    doc.image('Innovation-Bound-Logo.jpg', 231, 680, { width: 150 })

    // Footer
    doc.fontSize(9)
       .fillColor('#999999')
       .text('Thank you for enrolling in the 2026 AI Accelerator!', 50, 715, { align: 'center', width: 512 })
       .text('Questions? Contact accounting@innovationbound.com or call (212) 602-1401', 50, 730, { align: 'center', width: 512 })

    // Finalize PDF
    doc.end()
  })
}

// Side effect: Sends payment confirmation email with PAID invoice PDF
async function sendPaymentConfirmationEmail (data) {
  var { name, email, tierInfo, seats, totalAmount, company, phone, jobTitle, country } = data

  var rawHtml = await readFile("payment-confirmation.html", "utf8")
  var rawTxt = await readFile("payment-confirmation.txt", "utf8")

  var tracking = `email=${email}&list=ai-accelerator-payment&edition=confirmation`

  var html = rawHtml
    .replace(/{{name}}/g, name)
    .replace(/{{email}}/g, email)
    .replace(/{{tier}}/g, tierInfo.fee)
    .replace(/{{additionalSeats}}/g, seats.toString())
    .replace(/{{totalSeats}}/g, (10 + seats).toString())
    .replace(/{{totalAmount}}/g, `$${totalAmount.toLocaleString()}`)
    .replace(/{{company}}/g, company)
    .replace(/{{tracking}}/g, tracking)
    .replace(/{{emailSettings}}/g, `https://www.innovationbound.com/unsubscribe?email=${email}`)

  var txt = rawTxt
    .replace(/{{name}}/g, name)
    .replace(/{{email}}/g, email)
    .replace(/{{tier}}/g, tierInfo.fee)
    .replace(/{{additionalSeats}}/g, seats.toString())
    .replace(/{{totalSeats}}/g, (10 + seats).toString())
    .replace(/{{totalAmount}}/g, `$${totalAmount.toLocaleString()}`)
    .replace(/{{company}}/g, company)
    .replace(/{{tracking}}/g, tracking)
    .replace(/{{emailSettings}}/g, `https://www.innovationbound.com/unsubscribe?email=${email}`)

  // Generate PAID invoice PDF
  console.log(`Generating PAID invoice PDF for ${email}`)
  var pdfBase64 = await generateInvoicePDF(data, 'PAID')

  // Build raw email with PDF attachment
  var invoiceDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  var filename = `Innovation-Bound-AI-Accelerator-Invoice-PAID-${invoiceDate.replace(/\s/g, '-')}.pdf`

  var rawEmail = [
    'From: ' + replyToAddress,
    'To: ' + email,
    'Bcc: ' + replyToAddress,
    'Reply-To: ' + replyToAddress,
    'Subject: ✅ Welcome to the 2026 AI Accelerator!',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="NextPart"',
    `List-Unsubscribe: <https://www.innovationbound.com/unsubscribe?email=${email}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    '',
    '--NextPart',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '--NextPart',
    'Content-Type: application/pdf',
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    pdfBase64,
    '--NextPart--'
  ].join('\r\n')

  await ses.send(new SendRawEmailCommand({
    RawMessage: { Data: rawEmail },
    Source: replyToAddress.match(/<(.+)>/)[1] // Extract email from "Name <email>" format
  }))

  console.log(`Payment confirmation email with PAID invoice PDF sent to ${email}`)
}

// Side effect: Sends invoice request email with PDF attachment
async function sendInvoiceRequestEmail (data) {
  var { name, email, tierInfo, seats, totalAmount, company, phone, jobTitle, country } = data

  var rawHtml = await readFile("invoice-request.html", "utf8")
  var rawTxt = await readFile("invoice-request.txt", "utf8")

  var tracking = `email=${email}&list=ai-accelerator-payment&edition=invoice-request`

  var html = rawHtml
    .replace(/{{name}}/g, name)
    .replace(/{{email}}/g, email)
    .replace(/{{tier}}/g, tierInfo.fee)
    .replace(/{{additionalSeats}}/g, seats.toString())
    .replace(/{{totalSeats}}/g, (10 + seats).toString())
    .replace(/{{totalAmount}}/g, `$${totalAmount.toLocaleString()}`)
    .replace(/{{company}}/g, company)
    .replace(/{{phone}}/g, phone)
    .replace(/{{jobTitle}}/g, jobTitle)
    .replace(/{{tracking}}/g, tracking)
    .replace(/{{emailSettings}}/g, `https://www.innovationbound.com/unsubscribe?email=${email}`)

  var txt = rawTxt
    .replace(/{{name}}/g, name)
    .replace(/{{email}}/g, email)
    .replace(/{{tier}}/g, tierInfo.fee)
    .replace(/{{additionalSeats}}/g, seats.toString())
    .replace(/{{totalSeats}}/g, (10 + seats).toString())
    .replace(/{{totalAmount}}/g, `$${totalAmount.toLocaleString()}`)
    .replace(/{{company}}/g, company)
    .replace(/{{phone}}/g, phone)
    .replace(/{{jobTitle}}/g, jobTitle)
    .replace(/{{tracking}}/g, tracking)
    .replace(/{{emailSettings}}/g, `https://www.innovationbound.com/unsubscribe?email=${email}`)

  // Generate invoice PDF
  console.log(`Generating invoice PDF for ${email}`)
  var pdfBase64 = await generateInvoicePDF(data, 'DUE UPON RECEIPT')

  // Build raw email with PDF attachment
  var invoiceDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  var filename = `Innovation-Bound-AI-Accelerator-Invoice-${invoiceDate.replace(/\s/g, '-')}.pdf`

  var rawEmail = [
    'From: ' + replyToAddress,
    'To: ' + email,
    // TODO: Uncomment for production
    // 'Cc: ' + accountingEmail,
    'Bcc: ' + replyToAddress,
    'Reply-To: ' + replyToAddress,
    'Subject: 📄 Invoice Request for 2026 AI Accelerator',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="NextPart"',
    `List-Unsubscribe: <https://www.innovationbound.com/unsubscribe?email=${email}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    '',
    '--NextPart',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '--NextPart',
    'Content-Type: application/pdf',
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    pdfBase64,
    '--NextPart--'
  ].join('\r\n')

  await ses.send(new SendRawEmailCommand({
    RawMessage: { Data: rawEmail },
    Source: replyToAddress.match(/<(.+)>/)[1] // Extract email from "Name <email>" format
  }))

  console.log(`Invoice request email with PDF sent to ${email} (BCC: ${replyToAddress})`)
}

function respond (code, message) {
  return {
    body: code === 204 ? '' : JSON.stringify(message),
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin' : 'https://www.innovationbound.com',
      'Access-Control-Allow-Methods' : 'POST,OPTIONS',
      'Access-Control-Allow-Headers' : 'Accept, Content-Type, Authorization',
      'Access-Control-Allow-Credentials' : true
    },
    isBase64Encoded: false,
    statusCode: code
  }
}
