
/*
 * Route: api.innovationbound.com/services/training/chatgpt/accelerator/payment
 * Process payment or invoice request for 2026 AI Accelerator enrollment
 * Supports: Credit card (Stripe) and Invoice requests
 */

import { readFile } from 'fs/promises'
import Stripe from 'stripe'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

// TODO: Set STRIPE_SECRET_KEY environment variable
// Test key format: sk_test_...
// Live key format: sk_live_...
var stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_PLACEHOLDER')

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
        pk: "student#2026-ai-accelerator",
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
        pk: "student#2026-ai-accelerator",
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

// Side effect: Sends payment confirmation email
async function sendPaymentConfirmationEmail (data) {
  var { name, email, tierInfo, seats, totalAmount, company } = data

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

  await ses.send(new SendEmailCommand({
    Destination: {
      ToAddresses: [email],
      BccAddresses: [replyToAddress]
    },
    Message: {
      Body: {
        Html: { Charset: "UTF-8", Data: html },
        Text: { Charset: "UTF-8", Data: txt }
      },
      Subject: {
        Charset: "UTF-8",
        Data: `✅ Welcome to the 2026 AI Accelerator!`
      }
    },
    ReplyToAddresses: [replyToAddress],
    Source: replyToAddress
  }))

  console.log(`Payment confirmation email sent to ${email}`)
}

// Side effect: Sends invoice request email
async function sendInvoiceRequestEmail (data) {
  var { name, email, tierInfo, seats, totalAmount, company, phone, jobTitle } = data

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

  await ses.send(new SendEmailCommand({
    Destination: {
      ToAddresses: [email],
      CcAddresses: [accountingEmail],
      BccAddresses: [replyToAddress]
    },
    Message: {
      Body: {
        Html: { Charset: "UTF-8", Data: html },
        Text: { Charset: "UTF-8", Data: txt }
      },
      Subject: {
        Charset: "UTF-8",
        Data: `📄 Invoice Request for 2026 AI Accelerator`
      }
    },
    ReplyToAddresses: [replyToAddress],
    Source: replyToAddress
  }))

  console.log(`Invoice request email sent to ${email} (CC: ${accountingEmail})`)
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
