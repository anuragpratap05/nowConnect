# DevTinder APIs

## authRouter
- POST /signup
- POST /login
- POST /logout

## profileRouter
- GET /profile/view
- PATCH /profile/edit
- PATCH /profile/password // Forgot password API

## connectionRequestRouter
- POST /request/send/:status/:userId 
- POST /request/review/:status/:requestId

## userRouter
- GET /user/requests/received
- GET /user/connections
- GET /user/feed - Gets you the profiles of other users on platform

## chatRouter (Phase 3)
- GET /chat/:targetUserId?before=<messageId>&limit=50 - one page of history, newest-first cursor

## postRouter (Phase 4)
- POST /posts/upload-url - mint a presigned PUT URL (step 1 of 3)
- POST /posts - claim an uploaded object as a post (step 3 of 3)
- GET /posts/feed?cursor=&limit= - cursor-paginated, scoped to accepted connections
- GET /posts/user/:userId?cursor=&limit= - one author's posts, same authorization rule
- POST /posts/:postId/like - idempotent
- DELETE /posts/:postId/like - idempotent
- DELETE /posts/:postId - author only

Step 2 is not an API call: the client PUTs the image bytes directly to object
storage using the presigned URL. See the "Posts" folder in
`postman/devTinder.postman_collection.json` and the README for the full flow.


Status: ignored, interested, accepeted, rejected
