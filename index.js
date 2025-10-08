
/*
 * Route: api.innovationbound.com/services/training/chatgpt/accelerator/payment
 * Process payment or invoice request for 2026 AI Accelerator
 * Reads email, creates db entry, sends confirmation email, responds {event.body.confirmation}
 */

import { readFile } from 'fs/promises'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb'

var ses = new SESClient({ region: 'us-east-1' })
var dynamoDb = new DynamoDBClient({ region: 'us-east-1' })
var db = DynamoDBDocumentClient.from(dynamoDb)
var replyToAddress = "Innovation Bound <support@innovationbound.com>"

export async function handler (event) {
  console.log('EVENT:', JSON.stringify(event))
  if (event.httpMethod === 'OPTIONS') return respond(204) // For OPTIONS preflight
  try {
    // Event is already parsed JSON from API Gateway
    var json = event.body ? JSON.parse(event.body) : event
    var name = json.application.name ?? null
    var email = json.application.email ?? null
    var website = json.application.website ?? null
    var linkedin = json.application.linkedin ?? null
    var assistance = json.application.assistance ?? null

    // Validate incoming data
    console.log(`Validating application info for ${email || '(no email provided)'}.`)

    if (!name) return respond(400, {error: 'Name is required.'})
    if (!email) return respond(400, {error: 'Email is required.'})
    if (email.match(/@/) == null) return respond(400, {error: 'Please provide a valid email.'})
    if (!website) return respond(400, {error: 'Company Website is required.'})
    if (!linkedin) return respond(400, {error: 'LinkedIn Profile is required.'})
    if (assistance === null || assistance === undefined) return respond(400, {error: 'Assistance is required.'})
    if (![0, 25, 50, 75].includes(Number(assistance))) return respond(400, {error: 'Assistance must be 0, 25, 50, or 75.'})
    if (name.length > 2000) return respond(400, {error: 'Name must be 2000 characters or less.'})
    if (email.length > 2000) return respond(400, {error: 'Email must be 2000 characters or less.'})
    if (website.length > 2000) return respond(400, {error: 'Company Website must be 2000 characters or less.'})
    if (linkedin.length > 2000) return respond(400, {error: 'LinkedIn Profile must be 2000 characters or less.'})

    // Check if the company already has an application in
    var applicant = await db.send(new GetCommand({
      TableName: "www.innovationbound.com",
      Key: { pk: `application#ai-accelerator`, sk: email }
    }))

    if (applicant.Item) {
      return respond(400, {error: 'You have already applied to the 2026 AI Accelerator.'})
    }

    // Email data
    console.log(`Sending confirmation email to ${email}.`)

    var rawHtml = await readFile("email.html", "utf8")
    var rawTxt = await readFile("email.txt", "utf8")

    // Calculate assistance amount
    var assistanceAmounts = {
      '0': '$0',
      '25': '$7,500',
      '50': '$15,000',
      '75': '$22,500'
    }
    var assistanceAmount = assistanceAmounts[assistance] || '$0'

    // Replace template variables
    var html = rawHtml
      .replace(/{{tracking}}/g, `email=${email}&list=ai-accelerator-application&edition=confirmation`)
      .replace(/{{emailSettings}}/g, `https://www.innovationbound.com/unsubscribe?email=${email}`)
      .replace(/{{name}}/g, name)
      .replace(/{{email}}/g, email)
      .replace(/{{website}}/g, website)
      .replace(/{{linkedin}}/g, linkedin)
      .replace(/{{assistancePercent}}/g, assistance)
      .replace(/{{assistanceAmount}}/g, assistanceAmount)

    var txt = rawTxt
      .replace(/{{tracking}}/g, `email=${email}&list=ai-accelerator-application&edition=confirmation`)
      .replace(/{{emailSettings}}/g, `https://www.innovationbound.com/unsubscribe?email=${email}`)
      .replace(/{{name}}/g, name)
      .replace(/{{email}}/g, email)
      .replace(/{{website}}/g, website)
      .replace(/{{linkedin}}/g, linkedin)
      .replace(/{{assistancePercent}}/g, assistance)
      .replace(/{{assistanceAmount}}/g, assistanceAmount)

    var confirm = await ses.send(new SendEmailCommand({
      Destination: {
        ToAddresses: [email],
        BccAddresses: [replyToAddress]
      },
      Message: {
        Body: {
          Html: { Charset: "UTF-8", Data: html },
          Text: { Charset: "UTF-8", Data: txt }
        },
        Subject: { Charset: "UTF-8", Data: `📋 Application Confirmed for Innovation Bound's 2026 AI Accelerator - We'll respond within 3 days` }
      },
      ReplyToAddresses: [replyToAddress],
      Source: replyToAddress
    }))


    // Store list application
    var applied = await db.send(new PutCommand({
      TableName: "www.innovationbound.com",
      Item: {
        pk: `application#ai-accelerator`,
        sk: email,
        name: name,
        email: email,
        website: website,
        linkedin: linkedin,
        assistance: assistance,
        applied: new Date().toJSON()
      }
    }))


    // Respond
    return respond(200, {message: `Application confirmed for ${name}, ${email}.`})
  } catch (error) {
    console.log(error)
    return respond(500, {error: `500 - Something went wrong with ${email || '(no email provided)'}'s application for the 2026 AI Accelerator.`})
  }
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

