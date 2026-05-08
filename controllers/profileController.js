const Profile = require('../models/profileModel')
const json = require('../seed_profiles.json')

const countryMap = {}

const classifyAge = (age) => {
  if (age >= 0 && age <= 12) return 'child'
  if (age > 12 && age <= 19) return 'teenager'
  if (age > 19 && age <= 59) return 'adult'
  if (age >= 60) return 'senior'
  return undefined
}

const getHighestProbability = (data) => {
  const sorted = [...data].sort((a, b) => b.probability - a.probability)
  return sorted[0]
}

const getCountryFullName = (countryId) => {
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
  return regionNames.of(countryId)
}

const isValidNumber = (value) => !Number.isNaN(Number(value))
const isValidProbability = (value) => isValidNumber(value) && Number(value) >= 0 && Number(value) <= 1
const isValidPositiveInteger = (value) => Number.isInteger(Number(value)) && Number(value) > 0

const formatProfile = (profile) => ({
  id: profile.id,
  name: profile.name,
  gender: profile.gender,
  gender_probability: profile.gender_probability,
  age: profile.age,
  age_group: profile.age_group,
  sample_size: profile.sample_size,
  country_id: profile.country_id,
  country_name: profile.country_name || getCountryFullName(profile.country_id),
  country_probability: profile.country_probability,
  created_at: new Date(profile.created_at).toISOString()
})

const invalidExternalResponse = (res, externalApi) => (
  res.status(502).json({
    status: 'error',
    message: `${externalApi} returned an invalid response`
  })
)

const buildPaginatedResponse = (req, page, limit, total, data) => {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit)
  const query = new URLSearchParams()

  Object.entries(req.query).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      query.set(key, String(value))
    }
  })

  query.set('page', String(page))
  query.set('limit', String(limit))

  const buildLink = (targetPage) => {
    if (targetPage === null || targetPage < 1 || (totalPages > 0 && targetPage > totalPages)) {
      return null
    }

    const linkQuery = new URLSearchParams(query)
    linkQuery.set('page', String(targetPage))
    return `${req.baseUrl}${req.path}?${linkQuery.toString()}`
  }

  return {
    status: 'success',
    page,
    limit,
    total,
    total_pages: totalPages,
    links: {
      self: buildLink(page),
      next: page < totalPages ? buildLink(page + 1) : null,
      prev: page > 1 && totalPages > 0 ? buildLink(page - 1) : null
    },
    data
  }
}

const buildProfileFiltersAndSort = (query, options = {}) => {
  const {
    gender,
    country_id,
    age_group,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by = 'created_at',
    order,
    page = 1,
    limit = 10
  } = query

  const filters = {}
  const maxPageLimit = 50
  const maxLimit = Math.min(Number(limit), maxPageLimit)
  const currentPage = Number(page) || 1
  const sortingOptions = ['created_at', 'age', 'gender_probability']
  const orderOptions = ['asc', 'desc']
  const genderOptions = ['male', 'female']
  const ageGroupOptions = ['child', 'teenager', 'adult', 'senior']
  const shouldValidatePagination = options.validatePagination !== false

  if (shouldValidatePagination && (!isValidPositiveInteger(page) || !isValidPositiveInteger(limit))) {
    return { error: { status: 422, message: 'Invalid query parameters' } }
  }

  if (gender && !genderOptions.includes(gender.trim().toLowerCase())) {
    return { error: { status: 422, message: 'Invalid query parameters' } }
  }

  if (age_group && !ageGroupOptions.includes(age_group.trim().toLowerCase())) {
    return { error: { status: 422, message: 'Invalid query parameters' } }
  }

  if (country_id && !/^[A-Za-z]{2}$/.test(country_id.trim())) {
    return { error: { status: 422, message: 'Invalid query parameters' } }
  }

  if ((min_age && !isValidNumber(min_age)) || (max_age && !isValidNumber(max_age))) {
    return { error: { status: 422, message: 'Invalid query parameters' } }
  }

  if ((min_gender_probability && !isValidProbability(min_gender_probability)) || (min_country_probability && !isValidProbability(min_country_probability))) {
    return { error: { status: 422, message: 'Invalid query parameters' } }
  }

  if (min_age && max_age && Number(min_age) > Number(max_age)) {
    return { error: { status: 422, message: 'Invalid query parameters' } }
  }

  if (gender) filters.gender = gender.trim().toLowerCase()
  if (country_id) filters.country_id = country_id.trim().toUpperCase()
  if (age_group) filters.age_group = age_group.trim().toLowerCase()

  if (min_age) {
    filters.age = { ...(filters.age || {}), $gte: Number(min_age) }
  }

  if (max_age) {
    filters.age = { ...(filters.age || {}), $lte: Number(max_age) }
  }

  if (min_gender_probability) filters.gender_probability = { $gte: Number(min_gender_probability) }
  if (min_country_probability) filters.country_probability = { $gte: Number(min_country_probability) }

  if (!sortingOptions.includes(sort_by) || (order && !orderOptions.includes(order))) {
    return { error: { status: 422, message: 'Invalid query parameters' } }
  }

  return {
    filters,
    sortQuery: { [sort_by]: order === 'desc' ? -1 : 1 },
    maxLimit,
    currentPage
  }
}

const escapeCsvValue = (value) => {
  if (value === null || value === undefined) return ''
  const stringValue = String(value)
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`
  }
  return stringValue
}

const buildCsvFromProfiles = (profiles) => {
  const columns = [
    'id',
    'name',
    'gender',
    'gender_probability',
    'age',
    'age_group',
    'country_id',
    'country_name',
    'country_probability',
    'created_at'
  ]

  const rows = profiles.map((profile) => {
    const formatted = formatProfile(profile)
    return columns.map((column) => escapeCsvValue(formatted[column])).join(',')
  })

  return [columns.join(','), ...rows].join('\n')
}

json.forEach((profile) => {
  const name = profile.country_name?.toLowerCase()
  const id = profile.country_id

  if (name && id && !countryMap[name]) {
    countryMap[name] = id
  }
})

const registerProfile = async (req, res) => {
  try {
    const { name } = req.body || {}
    

    if (name === undefined || name === null || (typeof name === 'string' && name.trim().length === 0) || name === "''") {
      return res.status(400).json({ status: 'error', message: 'Missing or empty name' })
    }

    if (typeof name !== 'string') {
      return res.status(422).json({ status: 'error', message: 'Invalid type' })
    }

    const normalizedName = name.trim().toLowerCase()

    const genderResponse = await fetch(`https://api.genderize.io?name=${encodeURIComponent(normalizedName)}`)
    const ageResponse = await fetch(`https://api.agify.io?name=${encodeURIComponent(normalizedName)}`)
    const countryResponse = await fetch(`https://api.nationalize.io?name=${encodeURIComponent(normalizedName)}`)

    if (!genderResponse.ok) return invalidExternalResponse(res, 'Genderize')
    if (!ageResponse.ok) return invalidExternalResponse(res, 'Agify')
    if (!countryResponse.ok) return invalidExternalResponse(res, 'Nationalize')

    const genderData = await genderResponse.json()
    const ageData = await ageResponse.json()
    const countryData = await countryResponse.json()

    if (genderData.gender == null || genderData.count === 0) return invalidExternalResponse(res, 'Genderize')
    if (ageData.age == null) return invalidExternalResponse(res, 'Agify')
    if (!countryData.country || countryData.country.length === 0) return invalidExternalResponse(res, 'Nationalize')

    const highestProbabilityCountry = getHighestProbability(countryData.country)
    const existingData = await Profile.findOne({ name: normalizedName })

    if (existingData) {
      return res.status(200).json({
        status: 'success',
        message: 'Profile already exists',
        data: formatProfile(existingData)
      })
    }

    const savedData = new Profile({
      name: normalizedName,
      gender: genderData.gender,
      gender_probability: genderData.probability,
      sample_size: genderData.count,
      age: ageData.age,
      age_group: classifyAge(ageData.age),
      country_id: highestProbabilityCountry.country_id,
      country_name: getCountryFullName(highestProbabilityCountry.country_id),
      country_probability: highestProbabilityCountry.probability
    })

    await savedData.save()

    return res.status(201).json({
      status: 'success',
      data: formatProfile(savedData)
    })
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Server Error'
    })
  }
}

const getProfiles = async (req, res) => {
  try {
    
    const queryConfig = buildProfileFiltersAndSort(req.query)
    if (queryConfig.error) {
      return res.status(queryConfig.error.status).json({ status: 'error', message: queryConfig.error.message })
    }

    const { filters, sortQuery, maxLimit, currentPage } = queryConfig
    const skip = (currentPage - 1) * maxLimit
    const foundData = await Profile.find(filters).sort(sortQuery).skip(skip).limit(maxLimit)
    const total = await Profile.countDocuments(filters)

    return res.status(200).json(
      buildPaginatedResponse(req, currentPage, maxLimit, total, foundData.map(formatProfile))
    )
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Upstream or Server Failure'
    })
  }
}

const searchProfiles = async (req, res) => {
  try {
    

    const { q, page = 1, limit = 10 } = req.query
    const maxPageLimit = 50
    const maxLimit = Math.min(Number(limit), maxPageLimit)
    const currentPage = Number(page) || 1

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ status: 'error', message: 'Missing or empty search query' })
    }

    if (typeof q !== 'string' || !isValidPositiveInteger(page) || !isValidPositiveInteger(limit)) {
      return res.status(422).json({ status: 'error', message: 'Invalid query parameters' })
    }

    const words = q.toLowerCase().split(/\s+/)
    const aboveMatch = q.match(/above (\d+)/)

    if (q.toLowerCase().includes('above') && !aboveMatch) {
      return res.status(422).json({ status: 'error', message: 'Invalid query parameters' })
    }

    let hasMale = false
    let hasFemale = false
    let minAge = null
    let maxAge = null
    let hasAnyFilter = false

    const filters = {}
    const ageGroupMap = {
      child: 'child',
      teenager: 'teenager',
      teenagers: 'teenager',
      teens: 'teenager',
      adult: 'adult',
      senior: 'senior'
    }
    const genderMap = {
      male: 'male',
      males: 'male',
      boy: 'male',
      boys: 'male',
      female: 'female',
      females: 'female',
      girl: 'female',
      girls: 'female'
    }
    const ageRangeMap = {
      child: { min: 0, max: 12 },
      teenager: { min: 13, max: 19 },
      adult: { min: 20, max: 59 },
      senior: { min: 60, max: 120 },
      young: { min: 16, max: 24 }
    }

    for (const word of words) {
      if (genderMap[word] === 'male') hasMale = true
      if (genderMap[word] === 'female') hasFemale = true

      if (ageGroupMap[word]) {
        filters.age_group = ageGroupMap[word]
        hasAnyFilter = true
      }

      if (countryMap[word]) {
        filters.country_id = countryMap[word]
        hasAnyFilter = true
      }

      if (ageRangeMap[word]) {
        minAge = ageRangeMap[word].min
        maxAge = ageRangeMap[word].max
        hasAnyFilter = true
      }
    }

    const fromMatch = q.toLowerCase().match(/from\s+([a-z ]+)/)
    if (fromMatch) {
      const countryName = fromMatch[1].trim()
      if (countryMap[countryName]) {
        filters.country_id = countryMap[countryName]
        hasAnyFilter = true
      }
    }

    if (hasFemale && hasMale) {
      filters.gender = { $in: ['male', 'female'] }
      hasAnyFilter = true
    } else if (hasMale) {
      filters.gender = 'male'
      hasAnyFilter = true
    } else if (hasFemale) {
      filters.gender = 'female'
      hasAnyFilter = true
    }

    if (minAge !== null || maxAge !== null) {
      filters.age = {}
      if (minAge !== null) filters.age.$gte = minAge
      if (maxAge !== null) filters.age.$lte = maxAge
    }

    if (aboveMatch) {
      const age = Number(aboveMatch[1])
      minAge = minAge !== null ? Math.max(minAge, age) : age
      filters.age = filters.age || {}
      filters.age.$gte = minAge
      hasAnyFilter = true
    }

    if (!hasAnyFilter) {
      return res.status(400).json({ status: 'error', message: 'Unable to interpret query' })
    }

    const skip = (currentPage - 1) * maxLimit
    const foundData = await Profile.find(filters).skip(skip).limit(maxLimit)
    const total = await Profile.countDocuments(filters)

    return res.status(200).json(
      buildPaginatedResponse(req, currentPage, maxLimit, total, foundData.map(formatProfile))
    )
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Upstream or Server Failure'
    })
  }
}

const getProfileById = async (req, res) => {
  try {
    const { id } = req.params

    const foundData = await Profile.findOne({ id })

    if (!foundData) {
      return res.status(404).json({ status: 'error', message: 'Profile not found' })
    }

    return res.status(200).json({
      status: 'success',
      data: formatProfile(foundData)
    })
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Upstream or Server Failure'
    })
  }
}

const deleteProfileById = async (req, res) => {
  try {
    const { id } = req.params
    

    const deletedData = await Profile.findOneAndDelete({ id })

    if (!deletedData) {
      return res.status(404).json({ status: 'error', message: 'Profile not found' })
    }

    return res.status(204).send()
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Upstream or Server Failure'
    })
  }
}

const exportProfiles = async (req, res) => {
  try {
  

    if (req.query.format && req.query.format !== 'csv') {
      return res.status(422).json({ status: 'error', message: 'Invalid export format' })
    }

    const queryConfig = buildProfileFiltersAndSort(req.query, { validatePagination: false })

    if (queryConfig.error) {
      return res.status(queryConfig.error.status).json({ status: 'error', message: queryConfig.error.message })
    }

    const { filters, sortQuery } = queryConfig
    const profiles = await Profile.find(filters).sort(sortQuery)
    const csv = buildCsvFromProfiles(profiles)

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="profiles_${new Date().toISOString()}.csv"`)
    return res.status(200).send(csv)
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Upstream or Server Failure'
    })
  }
}

module.exports = {
  registerProfile,
  getProfiles,
  searchProfiles,
  getProfileById,
  deleteProfileById,
  exportProfiles
}
