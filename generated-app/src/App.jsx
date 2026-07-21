import React from 'react';
import './App.css';

const FeedbackForm = () => {
    return (
        <div className="feedback-form-container">
            <h1>We Value Your Feedback!</h1>
            <form>
                <label htmlFor="email">Email:</label>
                <input type="email" id="email" name="email" placeholder="Enter your email" required />
                <label htmlFor="rating">Rating:</label>
                <div className="rating-container">
                    <input type="radio" id="star5" name="rating" value="5" /><label htmlFor="star5">★</label>
                    <input type="radio" id="star4" name="rating" value="4" /><label htmlFor="star4">★</label>
                    <input type="radio" id="star3" name="rating" value="3" /><label htmlFor="star3">★</label>
                    <input type="radio" id="star2" name="rating" value="2" /><label htmlFor="star2">★</label>
                    <input type="radio" id="star1" name="rating" value="1" /><label htmlFor="star1">★</label>
                </div>
                <label htmlFor="comments">Comments:</label>
                <textarea id="comments" name="comments" rows="4" placeholder="Share your thoughts..." required></textarea>
                <button type="submit">Submit Feedback</button>
            </form>
        </div>
    );
};

export default FeedbackForm;